#!/usr/bin/env python3
"""
LeavenWealth ClickUp -> Supabase migration.

Migrates the ClickUp "Properties" space into the Supabase schema we built:
entity (self-referencing parent/child), property, unit, loan, loan_collateral,
loan_balance, insurance_policy, guarantor, reporting_requirement.

This version also stores each source ClickUp task id on the migrated property/unit
row (property.clickup_task_id / unit.clickup_task_id) so the two-way task sync can
resolve a task's "Property" relationship to a Supabase FK. Run supabase_task_sync.sql
first to add those columns.

USAGE
    pip install requests psycopg2-binary
    export CLICKUP_API_TOKEN="pk_..."          # ClickUp personal token
    export SUPABASE_DB_URL="postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres"

    python leavenwealth_migration.py --dry-run     # report only, no writes
    python leavenwealth_migration.py --reset       # clear data tables, then load (WITH clickup ids)
    python leavenwealth_migration.py               # load (append)
    python leavenwealth_migration.py --relink      # only backfill property/unit.clickup_task_id (by name)

Outputs: migration_log.txt and anomalies.csv in the working directory.
"""

import os
import re
import sys
import csv
import time
import argparse
from datetime import datetime, timezone

import requests
import psycopg2
import psycopg2.extras

# ---------------------------------------------------------------------------
# Constants (from the live ClickUp workspace)
# ---------------------------------------------------------------------------
CLICKUP_API = "https://api.clickup.com/api/v2"
SPACE_ID = "90142742038"            # Properties space
LOAN_FOLDER_ID = "90147274220"      # 001 - Loan Data
TEMPLATE_FOLDER_ID = "90145442447"  # 000 - Data Template (skip)
TASKS_FOLDER_ID = "901410202926"    # Tasks and Projects (skip)
DATA_ITEM_ID = 1001                 # custom_item_id for the "Project Name" type = real data record

SKIP_FOLDER_IDS = {LOAN_FOLDER_ID, TEMPLATE_FOLDER_ID, TASKS_FOLDER_ID}

TOKEN = os.environ.get("CLICKUP_API_TOKEN")
DB_URL = os.environ.get("SUPABASE_DB_URL")

anomalies = []   # rows for anomalies.csv
log_lines = []


def log(msg):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line)
    log_lines.append(line)


def flag(kind, detail, clickup_url=""):
    anomalies.append({"type": kind, "detail": detail, "clickup_url": clickup_url})
    log(f"  ANOMALY [{kind}] {detail}")


# ---------------------------------------------------------------------------
# ClickUp API helpers
# ---------------------------------------------------------------------------
def cu_get(path, params=None):
    headers = {"Authorization": TOKEN}
    for attempt in range(5):
        r = requests.get(f"{CLICKUP_API}{path}", headers=headers, params=params or {})
        if r.status_code == 429:          # rate limited
            time.sleep(2 ** attempt)
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()


def get_folders():
    return cu_get(f"/space/{SPACE_ID}/folder", {"archived": "false"}).get("folders", [])


def get_lists(folder_id):
    return cu_get(f"/folder/{folder_id}/list", {"archived": "false"}).get("lists", [])


def get_tasks(list_id):
    """All tasks in a list WITH custom field values, paginated."""
    out, page = [], 0
    while True:
        data = cu_get(f"/list/{list_id}/task", {
            "include_closed": "true", "subtasks": "true", "page": page,
        })
        tasks = data.get("tasks", [])
        out.extend(tasks)
        if data.get("last_page", True) or not tasks:
            break
        page += 1
    return out


def get_task(task_id):
    return cu_get(f"/task/{task_id}", {"custom_task_ids": "false"})


# ---------------------------------------------------------------------------
# Custom-field value decoding
# ---------------------------------------------------------------------------
def fields_by_name(task):
    return {f["name"]: f for f in task.get("custom_fields", [])}


def _epoch_ms_to_date(v):
    try:
        return datetime.fromtimestamp(int(v) / 1000, tz=timezone.utc).date().isoformat()
    except (ValueError, TypeError, OSError):
        return None


def fval(fmap, name):
    """Decode a custom field value by name into a Python scalar/None."""
    f = fmap.get(name)
    if not f or "value" not in f or f["value"] in (None, "", []):
        return None
    v = f["value"]
    t = f["type"]
    if t in ("short_text", "text", "url", "phone", "email"):
        s = str(v).strip()
        return s or None
    if t in ("currency", "number"):
        try:
            return float(str(v).replace(",", "").replace("$", ""))
        except ValueError:
            return None
    if t == "date":
        return _epoch_ms_to_date(v)
    if t == "checkbox":
        return str(v).lower() == "true"
    if t == "drop_down":
        opts = f.get("type_config", {}).get("options", [])
        # value is the option orderindex
        for o in opts:
            if o.get("orderindex") == v or str(o.get("id")) == str(v):
                return o.get("name")
        return None
    if t == "labels":
        opts = {o["id"]: o.get("label", o.get("name")) for o in f.get("type_config", {}).get("options", [])}
        ids = v if isinstance(v, list) else [v]
        names = [opts.get(i) for i in ids if opts.get(i)]
        return names or None
    if t == "users":
        names = [u.get("username") or u.get("email") for u in (v if isinstance(v, list) else [v])]
        return [n for n in names if n] or None
    if t == "tasks":  # relationship
        return [t_["id"] for t_ in v] if isinstance(v, list) else None
    return None


def first(x):
    return x[0] if isinstance(x, list) and x else (x if not isinstance(x, list) else None)


# A unit/building task is "<property name> - <descriptor>" where descriptor
# starts with Building / Bldg / Garage / Shed / Unit.
UNIT_RE = re.compile(
    r'^(?P<prop>.+?)\s*-\s*(?P<unit>(?:Building|Bldg\.?|Garage|Shed|Unit)\b.*)$',
    re.IGNORECASE,
)


def split_unit(name):
    """Return (property_name, unit_descriptor_or_None)."""
    m = UNIT_RE.match(name.strip())
    if m:
        return m.group("prop").strip(), m.group("unit").strip()
    return name.strip(), None


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
class DB:
    def __init__(self, conn):
        self.c = conn

    def insert(self, table, data):
        cols = [k for k, v in data.items() if v is not None]
        vals = [data[k] for k in cols]
        ph = ", ".join(["%s"] * len(cols))
        sql = f'insert into public.{table} ({", ".join(cols)}) values ({ph}) returning id'
        cur = self.c.cursor()
        cur.execute(sql, vals)
        new_id = cur.fetchone()[0]
        cur.close()
        return new_id

    def reset(self):
        cur = self.c.cursor()
        cur.execute("""
            truncate public.loan_balance, public.loan_collateral, public.reporting_requirement,
                     public.guarantor, public.insurance_policy, public.loan,
                     public.unit, public.property, public.entity
            restart identity cascade;
        """)
        cur.close()
        log("Data tables truncated (entity, property, unit, loan, links, balances, insurance, guarantors, reporting).")


# ---------------------------------------------------------------------------
# Field -> column mappers
# ---------------------------------------------------------------------------
def property_row(fmap, entity_id, clickup_task_id=None):
    return {
        "entity_id": entity_id,
        "clickup_task_id": clickup_task_id,   # source ClickUp record id (for task-sync linking)
        "dba_name": fval(fmap, "DBA Name / Name of Apartment Complex"),
        "street": fval(fmap, "Location Street Address"),
        "city": fval(fmap, "Location City"),
        "state": fval(fmap, "Location State"),
        "zip": fval(fmap, "Location Zip"),
        "parcel_id": fval(fmap, "Parcel ID"),
        "county_assessor_url": fval(fmap, "County Assessor Website"),
        "dropbox_url": fval(fmap, "Dropbox Link"),
        "management_company": first(fval(fmap, "Management Company")),
        "purchase_price": fval(fmap, "Purchase Price"),
        "purchase_date": fval(fmap, "Purchase Date"),
        "current_market_value": fval(fmap, "Current Market Value"),
        "current_market_value_2023": fval(fmap, "Current Market Value (23')"),
        "year_built": fval(fmap, "Year Built"),
        "square_feet": int(fval(fmap, "Square Feet")) if fval(fmap, "Square Feet") else None,
        "stories": fval(fmap, "# of Stories"),
        "num_buildings": fval(fmap, "# of Buildings"),
        "unit_count_reported": int(fval(fmap, "Total Units")) if fval(fmap, "Total Units") else None,
        "construction_type": fval(fmap, "Building Construction"),
        "pool": fval(fmap, "Pool"),
        "vehicles": fval(fmap, "Vehicles"),
        "service_provider": fval(fmap, "Service Provider"),
        "reviews_property_tax": fval(fmap, "Does LWC Review Property Tax Payments?"),
        "reposition_cadence": fval(fmap, "Reposition Cadence"),
        "collateral_notes": fval(fmap, "Collateral"),
    }


def unit_row(fmap, property_id, name, clickup_task_id=None):
    return {
        "property_id": property_id,
        "clickup_task_id": clickup_task_id,   # source ClickUp record id (for task-sync linking)
        "unit_identifier": name,
        "dba_name": fval(fmap, "DBA Name / Name of Apartment Complex"),
        "parcel_id": fval(fmap, "Parcel ID"),
        "year_built": fval(fmap, "Year Built"),
        "construction_type": fval(fmap, "Building Construction"),
        "stories": fval(fmap, "# of Stories"),
        "square_feet": int(fval(fmap, "Square Feet")) if fval(fmap, "Square Feet") else None,
        "pool": fval(fmap, "Pool"),
        "vehicles": fval(fmap, "Vehicles"),
        "current_market_value": fval(fmap, "Current Market Value"),
        "current_market_value_2023": fval(fmap, "Current Market Value (23')"),
        "num_buildings": fval(fmap, "# of Buildings"),
        "location_street": fval(fmap, "Location Street Address"),
        "location_city": fval(fmap, "Location City"),
        "location_state": fval(fmap, "Location State"),
        "location_zip": fval(fmap, "Location Zip"),
    }


def insurance_row(fmap, property_id=None, unit_id=None):
    row = {
        "property_id": property_id,
        "unit_id": unit_id,
        "carrier": fval(fmap, "Insurance Carrier"),
        "annual_premium": fval(fmap, "Insurance Annual Premium"),
        "renewal_date": fval(fmap, "Insurance Renewal Date"),
        "tiv": fval(fmap, "TIV  (Total Insured Value)"),
        "all_other_perils_deductible": fval(fmap, "All Other Perils Deductible"),
        "wind_hail_deductible": fval(fmap, "Wind/Hail Deductible"),
        "business_personal_property": fval(fmap, "Business Personal Property"),
        "business_income_extra_expense_limit": fval(fmap, "Business Income & Extra Expense Limit"),
        "building_limit_replacement_cost": fval(fmap, "Building Limit (Replacement Cost)"),
    }
    has_data = any(v is not None for k, v in row.items() if k not in ("property_id", "unit_id"))
    return row if has_data else None


LOAN_STATUS_MAP = {"None": "none", "Pending": "pending", "Active": "active", "Closed": "closed"}


def loan_row(fmap, borrower_entity_id, clickup_task_id=None, source_list_name=None):
    status = LOAN_STATUS_MAP.get(fval(fmap, "Loan Status") or "", "none")
    ltype = (fval(fmap, "Loan Type") or "").lower() or None
    amort = (fval(fmap, "Amortizing Type") or "").lower() or None
    return {
        "borrower_entity_id": borrower_entity_id,
        "loan_number": fval(fmap, "Loan Number"),
        "loan_type": ltype,
        "amortizing_type": amort,
        "origination_amount": fval(fmap, "Loan Origination Amount"),
        "origination_date": fval(fmap, "Origination Date") or fval(fmap, "Loan Origination Date"),
        "maturity_date": fval(fmap, "Maturity Date"),
        "interest_rate": fval(fmap, "Interest Rate %") or fval(fmap, "Interest Rate"),
        "interest_type": fval(fmap, "Interest Type"),
        "amortization": fval(fmap, "Amortization"),
        "balloon_payment": fval(fmap, "Balloon Payment"),
        "balloon_payment_notes": fval(fmap, "Balloon Payments"),
        "interest_only_end_date": fval(fmap, "Interest Only End Date") or fval(fmap, "End IO Period"),
        "index": fval(fmap, "Index"),
        "variable_rate_floor": fval(fmap, "Variable Rate Floor"),
        "variable_rate_max": fval(fmap, "Variable Rate Max"),
        "rate_change_limitation": fval(fmap, "Rate Change Limitation per Change Date"),
        "previous_interest_reset_date": fval(fmap, "Previous Interest Reset Date"),
        "next_interest_reset_date": fval(fmap, "Next Interest Reset Date"),
        "interest_reset_cadence": fval(fmap, "Interest Reset Cadence"),
        "primary_mortgage": fval(fmap, "Primary Mortgage"),
        "bridge": fval(fmap, "Bridge"),
        "primary_plus_construction_note": fval(fmap, "Primary + Construction Note"),
        "construction_note": fval(fmap, "Construction Note"),
        "construction_budget_amount": fval(fmap, "Construction Budget"),
        "pace_equity": fval(fmap, "PACE Equity"),
        "seller_carry": fval(fmap, "Seller Carry/Financing"),
        "repayment_fee": fval(fmap, "Repayment Fee"),
        "prepayment_penalties": fval(fmap, "Prepayment Penalties"),
        "payment_frequency": fval(fmap, "Payment Frequency"),
        "extension_available": fval(fmap, "Extension Available"),
        "extension_requirements": fval(fmap, "Extension Requirements"),
        "lender": fval(fmap, "Lender"),
        "dscr": fval(fmap, "DSCR"),
        "debt_paid_by": fval(fmap, "Debt Paid By"),
        "loc_beginning": fval(fmap, "Beginning LOC"),
        "loc_available": fval(fmap, "Available LOC"),
        "avail_escrow_reserve": fval(fmap, "Avail Escrow/Reserve"),
        "loc_draws_process": fval(fmap, "LOC Draws Process"),
        "lender_held_cash_reserve": fval(fmap, "Lender Held Cash Reserve"),
        "distribution_frequency_restrictions": fval(fmap, "Distribution Frequency Restrictions"),
        "pac_due": fval(fmap, "PAC DUE"),
        "covenant_lender_operating_account": fval(fmap, "Covenants - Lender Operating Account"),
        "covenant_audit": fval(fmap, "Covenant - Audit"),
        "covenant_replacement_reserve": fval(fmap, "Covenants - Replacement Reserve"),
        "covenant_distribution_frequency": fval(fmap, "Covenants - Distribution Frequency"),
        "last_draw_amount": fval(fmap, "Last Draw Amount"),
        "amount_left_to_draw": fval(fmap, "amount left to draw"),
        "last_draw_date": fval(fmap, "last draw date"),
        "status": status,
        "clickup_task_id": clickup_task_id,         # source ClickUp loan task id
        "source_list_name": source_list_name,        # originating list (address/property)
    }


REPORTING_FIELDS = [
    ("Rent Roll (Monthly)", "Rent Roll", "monthly"),
    ("Rent Roll (Quarterly Report)", "Rent Roll", "quarterly"),
    ("Rent Roll (Annual Report)", "Rent Roll", "annual"),
    ("P&L (Quarterly Report)", "P&L", "quarterly"),
    ("P&L (Annual Report)", "P&L", "annual"),
    ("Balance Sheet (Quarterly Report)", "Balance Sheet", "quarterly"),
    ("Balance Sheet (Annual Report)", "Balance Sheet", "annual"),
    ("Audited Financials (Annual Report)", "Audited Financials", "annual"),
    ("Tax Return - Deal Level (Annual Report)", "Tax Return (Deal Level)", "annual"),
    ("Tax Return - Guarantors (Annual Report)", "Tax Return (Guarantors)", "annual"),
    ("PFS - Guarantors (Annual Report)", "PFS (Guarantors)", "annual"),
]


def balance_rows(fmap):
    """Dated balance snapshots from the various 'Balance as of ...' fields."""
    out = []
    pairs = [
        ("Balance as of 12/31/2025", "2025-12-31"),
        ("Balance as of 9/30/2025", "2025-09-30"),
    ]
    for name, d in pairs:
        v = fval(fmap, name)
        if v is not None:
            out.append((d, v))
    # property-level current debt
    debt = fval(fmap, "Current Debt as of (09/30/24)")
    if debt is not None:
        out.append((fval(fmap, "As of Date") or "2024-09-30", debt))
    return out


# ---------------------------------------------------------------------------
# --relink: backfill property/unit.clickup_task_id on existing rows (by name).
# Use after adding the columns if you don't want to re-run a full --reset load.
# Best-effort name match — re-running --reset is the reliable path.
# ---------------------------------------------------------------------------
def relink(conn):
    cur = conn.cursor()
    updated_p = updated_u = unmatched = 0
    linked_task_ids = set()   # loan task ids referenced by a property/unit (= NOT unlinked)
    for folder in get_folders():
        if folder["id"] in SKIP_FOLDER_IDS:
            continue
        for lst in get_lists(folder["id"]):
            for t in get_tasks(lst["id"]):
                if t.get("custom_item_id") != DATA_ITEM_ID:
                    continue
                for ltid in (fval(fields_by_name(t), "Loans") or []):
                    linked_task_ids.add(str(ltid))
                pname, descriptor = split_unit(t["name"])
                if descriptor is None:
                    cur.execute(
                        "update public.property set clickup_task_id=%s "
                        "where clickup_task_id is null and dba_name=%s",
                        (t["id"], pname))
                    if cur.rowcount:
                        updated_p += cur.rowcount
                    else:
                        unmatched += 1
                        flag("relink_unmatched_property", f"No property row matched '{pname}'", t.get("url", ""))
                else:
                    cur.execute(
                        "update public.unit set clickup_task_id=%s "
                        "where clickup_task_id is null and unit_identifier=%s",
                        (t["id"], descriptor))
                    if cur.rowcount:
                        updated_u += cur.rowcount
                    else:
                        unmatched += 1
                        flag("relink_unmatched_unit", f"No unit row matched '{descriptor}'", t.get("url", ""))
    conn.commit()

    # ---- Loans: backfill source_list_name + clickup_task_id ----
    # (a) maintain rows that already carry a clickup_task_id (idempotent).
    loans_updated = 0
    for lst in get_lists(LOAN_FOLDER_ID):
        for t in get_tasks(lst["id"]):
            if t.get("custom_item_id") != DATA_ITEM_ID:
                continue
            cur.execute("update public.loan set source_list_name=%s where clickup_task_id=%s",
                        (lst["name"], str(t["id"])))
            loans_updated += cur.rowcount
    conn.commit()
    # (b) Recreate the UNLINKED loans (no borrower, no collateral, no clickup id →
    #     no dependents) so they gain source_list_name + clickup_task_id. Linked
    #     loans + any the user already assigned are left untouched.
    cur.execute("""delete from public.loan l
                   where l.borrower_entity_id is null and l.clickup_task_id is null
                     and not exists (select 1 from public.loan_collateral c where c.loan_id = l.id)""")
    deleted_unlinked = cur.rowcount
    conn.commit()
    db2 = DB(conn)
    loans_recreated = 0
    for lst in get_lists(LOAN_FOLDER_ID):
        for t in get_tasks(lst["id"]):
            if t.get("custom_item_id") != DATA_ITEM_ID:
                continue
            tid = str(t["id"])
            if tid in linked_task_ids:
                continue   # belongs to a property/unit — not an unlinked loan
            cur.execute("select 1 from public.loan where clickup_task_id=%s limit 1", (tid,))
            if cur.fetchone():
                continue   # already present (idempotent re-run)
            fmap = fields_by_name(t)
            lid = db2.insert("loan", loan_row(fmap, None, tid, lst["name"]))
            for d, bal in balance_rows(fmap):
                if d is not None and bal is not None:
                    db2.insert("loan_balance", {"loan_id": lid, "as_of_date": d, "balance": bal})
            for fname, rtype, freq in REPORTING_FIELDS:
                if fval(fmap, fname) is True:
                    db2.insert("reporting_requirement", {"loan_id": lid, "report_type": rtype, "frequency": freq})
            loans_recreated += 1
    conn.commit()
    cur.close()
    log(f"Relink complete: {updated_p} properties, {updated_u} units updated; {unmatched} unmatched.")
    log(f"Relink loans: {loans_updated} updated by id; {deleted_unlinked} unlinked deleted, {loans_recreated} recreated with source_list_name + clickup_task_id.")


# ---------------------------------------------------------------------------
# Main migration
# ---------------------------------------------------------------------------
def run(dry_run, do_reset):
    if not TOKEN or not DB_URL:
        sys.exit("Set CLICKUP_API_TOKEN and SUPABASE_DB_URL environment variables.")

    conn = psycopg2.connect(DB_URL)
    conn.autocommit = False
    db = DB(conn)
    if do_reset and not dry_run:
        db.reset()

    entity_ids = {}          # entity name -> uuid
    loan_ids = {}            # clickup loan task id -> uuid
    counts = {"entities": 0, "properties": 0, "units": 0, "loans": 0,
              "collateral": 0, "balances": 0, "insurance": 0,
              "guarantors": 0, "reporting": 0, "skipped_workflow": 0}

    def ensure_entity(name, parent_id=None):
        if not name:
            return None
        if name in entity_ids:
            return entity_ids[name]
        if dry_run:
            entity_ids[name] = f"dry-{len(entity_ids)}"
        else:
            entity_ids[name] = db.insert("entity", {"name": name, "parent_entity_id": parent_id})
        counts["entities"] += 1
        return entity_ids[name]

    def add_balance(lid, d, bal):
        if not lid or d is None or bal is None:
            return
        if not dry_run:
            db.insert("loan_balance", {"loan_id": lid, "as_of_date": d, "balance": bal})
        counts["balances"] += 1

    def import_loan(loan_task_id, borrower_entity_id, task=None, source_list_name=None):
        if loan_task_id in loan_ids:
            return loan_ids[loan_task_id]
        if task is None:
            try:
                task = get_task(loan_task_id)
            except Exception as e:
                flag("loan_fetch_failed", f"{loan_task_id}: {e}")
                return None
        fmap = fields_by_name(task)
        # Originating list = the address/property the loan task lives under.
        src_name = source_list_name or (task.get("list") or {}).get("name")
        lid = "dry-loan" if dry_run else db.insert(
            "loan", loan_row(fmap, borrower_entity_id, str(loan_task_id), src_name))
        loan_ids[loan_task_id] = lid
        counts["loans"] += 1
        for d, bal in balance_rows(fmap):
            add_balance(lid, d, bal)
        for fname, rtype, freq in REPORTING_FIELDS:
            if fval(fmap, fname) is True:
                if not dry_run:
                    db.insert("reporting_requirement",
                              {"loan_id": lid, "report_type": rtype, "frequency": freq})
                counts["reporting"] += 1
        return lid

    folders = get_folders()
    log(f"Found {len(folders)} folders in Properties space.")

    for folder in folders:
        fid = folder["id"]
        if fid in SKIP_FOLDER_IDS:
            continue
        fname = folder["name"]
        lists = get_lists(fid)
        log(f"\nFolder: {fname}  ({len(lists)} lists)")

        # ---- First pass: collect owner entities to decide parent/child shape ----
        list_tasks = {}
        owner_names = set()
        for lst in lists:
            tasks = get_tasks(lst["id"])
            list_tasks[lst["id"]] = (lst["name"], tasks)
            for t in tasks:
                if t.get("custom_item_id") == DATA_ITEM_ID:
                    own = first(fval(fields_by_name(t), "Owner Entity"))
                    if own:
                        owner_names.add(own)

        # Parent rule: folder groups multiple distinct LLCs -> folder is parent.
        parent_id = None
        if len(owner_names) > 1:
            parent_id = ensure_entity(fname)

        # ---- Second pass: group tasks into properties + their units ----
        for lid_key, (lname, tasks) in list_tasks.items():
            data_tasks = [t for t in tasks if t.get("custom_item_id") == DATA_ITEM_ID]
            counts["skipped_workflow"] += len(tasks) - len(data_tasks)
            if not data_tasks:
                continue

            # Group by property name (prefix before "- Building/Garage/...").
            # A list may contain more than one property.
            groups = {}  # prop_name -> {"prop": task|None, "units": [(descriptor, task)]}
            for t in data_tasks:
                pname, descriptor = split_unit(t["name"])
                g = groups.setdefault(pname, {"prop": None, "units": []})
                if descriptor is None:
                    if g["prop"] is None:
                        g["prop"] = t
                    else:
                        flag("duplicate_property_task",
                             f"Two property tasks named '{pname}' in list '{lname}'",
                             t.get("url", ""))
                else:
                    g["units"].append((descriptor, t))

            for pname, g in groups.items():
                prop_task = g["prop"]
                src = prop_task or (g["units"][0][1] if g["units"] else None)
                if src is None:
                    continue
                pmap = fields_by_name(src)
                own_name = first(fval(pmap, "Owner Entity")) or pname or lname
                child_id = ensure_entity(own_name, parent_id)

                prow = property_row(pmap, child_id, prop_task["id"] if prop_task else None)
                if not prow.get("dba_name"):
                    prow["dba_name"] = pname
                prop_id = "dry-prop" if dry_run else db.insert("property", prow)
                counts["properties"] += 1
                if prop_task is None:
                    flag("property_synthesized",
                         f"No standalone property task for '{pname}' in list '{lname}'; "
                         f"created from its {len(g['units'])} building(s)",
                         src.get("url", ""))

                # property-level insurance only when there is a real property task
                loan_links = []
                if prop_task is not None:
                    ins = insurance_row(pmap, property_id=prop_id)
                    if ins and not dry_run:
                        db.insert("insurance_policy", ins)
                    if ins:
                        counts["insurance"] += 1

                    loan_links = fval(pmap, "Loans") or []
                    # Property-level current debt becomes a dated balance on the
                    # linked loan (only when there is exactly one, to avoid double counting).
                    debt = fval(pmap, "Current Debt as of (09/30/24)")
                    debt_date = fval(pmap, "As of Date") or "2024-09-30"
                    for ltid in loan_links:
                        lid = import_loan(ltid, child_id)
                        if lid and not dry_run:
                            db.insert("loan_collateral", {"loan_id": lid, "property_id": prop_id})
                        if lid:
                            counts["collateral"] += 1
                            if debt is not None and len(loan_links) == 1:
                                add_balance(lid, debt_date, debt)

                    guar = fval(pmap, "Guarantors")
                    if guar:
                        for gname in guar:
                            for ltid in loan_links:
                                lid = loan_ids.get(ltid)
                                if lid and not dry_run:
                                    db.insert("guarantor", {
                                        "loan_id": lid, "name": gname,
                                        "guaranteed_amount": fval(pmap, "Guaranteed Amount per Guarantor"),
                                        "guarantees": fval(pmap, "Guarantees"),
                                    })
                                if lid:
                                    counts["guarantors"] += 1

                # units / buildings
                for descriptor, t in g["units"]:
                    umap = fields_by_name(t)
                    uid = "dry-unit" if dry_run else db.insert("unit", unit_row(umap, prop_id, descriptor, t["id"]))
                    counts["units"] += 1
                    uins = insurance_row(umap, unit_id=uid)
                    if uins and not dry_run:
                        db.insert("insurance_policy", uins)
                    if uins:
                        counts["insurance"] += 1
                    for ltid in (fval(umap, "Loans") or []):
                        lid = import_loan(ltid, child_id)
                        if lid and not dry_run:
                            db.insert("loan_collateral", {"loan_id": lid, "unit_id": uid})
                        if lid:
                            counts["collateral"] += 1

        if not dry_run:
            conn.commit()

    # ---- Sweep loan folder: import any loan never linked from a property ----
    log("\nSweeping 001 - Loan Data for loans not linked to any property...")
    for lst in get_lists(LOAN_FOLDER_ID):
        for t in get_tasks(lst["id"]):
            if t.get("custom_item_id") == DATA_ITEM_ID and t["id"] not in loan_ids:
                import_loan(t["id"], None, task=t, source_list_name=lst["name"])   # borrower/collateral unknown
                flag("unlinked_loan",
                     f"Loan '{t['name']}' in list '{lst['name']}' imported with no property "
                     f"link; assign borrower & collateral manually",
                     t.get("url", ""))

    if not dry_run:
        conn.commit()
    conn.close()

    # ---- Output ----
    log("\n=== SUMMARY ===")
    for k, v in counts.items():
        log(f"  {k:18} {v}")
    log(f"  anomalies          {len(anomalies)}")

    with open("anomalies.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["type", "detail", "clickup_url"])
        w.writeheader()
        w.writerows(anomalies)
    with open("migration_log.txt", "w") as fh:
        fh.write("\n".join(log_lines))
    log("\nWrote anomalies.csv and migration_log.txt")
    if dry_run:
        log("DRY RUN - no data was written.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    ap.add_argument("--reset", action="store_true", help="truncate data tables before loading")
    ap.add_argument("--relink", action="store_true",
                    help="only backfill property/unit.clickup_task_id on existing rows (by name)")
    args = ap.parse_args()

    if args.relink:
        if not TOKEN or not DB_URL:
            sys.exit("Set CLICKUP_API_TOKEN and SUPABASE_DB_URL environment variables.")
        _conn = psycopg2.connect(DB_URL)
        _conn.autocommit = False
        relink(_conn)
        _conn.close()
        with open("migration_log.txt", "w") as fh:
            fh.write("\n".join(log_lines))
        with open("anomalies.csv", "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=["type", "detail", "clickup_url"])
            w.writeheader()
            w.writerows(anomalies)
    else:
        run(args.dry_run, args.reset)
