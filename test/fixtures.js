/* Fixture payload shaped exactly like GET /api/tasks.
   Status names are the real ones in use in the LeavenWealth ClickUp workspace
   (complete, done, to do, in progress, not started, not reporting, in review,
   quarterly recurring), so the canonical mapping is exercised for real.

   Every task carries a `_intent` note saying which of the four cards it should
   land in. The expectations in dev/expected.json are written from those notes by
   hand, NOT derived from the same code the tests are checking. */
(function () {
  var LW = { AM: '90141115902', ACQ: '90141115716', CMJ: '90144437822' };
  var LEADLI = '90144463335';           // out of LeavenWealth scope on purpose
  var d = new Date(); d.setHours(0, 0, 0, 0);
  var SOD = d.getTime();                // start of today
  var DAY = 86400000;

  function T(o) {
    return {
      id: o.id,
      name: o.name,
      url: 'https://app.clickup.com/t/' + o.id,
      status: { status: o.status, type: o.type || 'custom', color: '#888', orderindex: 0 },
      canonical_status: o.canon,        // as the server would send it
      due_date: o.due == null ? null : String(o.due),
      date_created: String(SOD - 30 * DAY),
      date_updated: String(SOD - DAY),
      assignees: o.assignees || [],
      priority: o.priority ? { id: o.priority.id, priority: o.priority.name } : null,
      parent: o.parent || null,
      space: { id: o.space, name: o.spaceName || 'Asset Management' },
      list: { id: o.list || '901406495307', name: o.listName || "AM To-Do's" },
      folder: null,
      custom_fields: [],
      _intent: o.intent,
    };
  }

  var BRIAN = { id: 88214150, username: 'Brian Nelson', initials: 'BN' };
  var JOHN = { id: 82341045, username: 'John Younes', initials: 'JY' };
  var MITCH = { id: 82341041, username: 'Mitchell Hagen', initials: 'MH' };

  var tasks = [
    T({ id: 'T1', name: 'Reach out to Appfolio IM about Alpha Grouping of Brent Village',
        status: 'to do', canon: 'To Do', due: null, space: LW.AM, assignees: [],
        intent: 'open' }),
    T({ id: 'T2', name: 'Discuss $143k Line of Credit — Use It or Lose It',
        status: 'to do', canon: 'To Do', due: SOD - 3 * DAY, space: LW.AM, assignees: [BRIAN],
        priority: { id: 2, name: 'high' }, intent: 'open, overdue' }),
    T({ id: 'T3', name: 'Portfolio Projections',
        status: 'in progress', canon: 'In Progress', due: SOD + 9 * 3600000, space: LW.AM,
        assignees: [{ id: 82341038, username: 'Chris Pomerleau', initials: 'CP' }],
        intent: 'open, dueweek — due 09:00 TODAY. Must NOT be overdue: the boundary is start of day, not now.' }),
    T({ id: 'T4', name: 'Complete MF Data Tape — Academy Fund',
        status: 'in progress', canon: 'In Progress', due: SOD + 23 * 3600000, space: LW.AM,
        assignees: [BRIAN], intent: 'open, dueweek' }),
    T({ id: 'T5', name: 'Brent Village Replacement Reserve — Greystone',
        status: 'to do', canon: 'To Do', due: SOD + 3 * DAY, space: LW.AM, assignees: [BRIAN],
        intent: 'open, dueweek' }),
    T({ id: 'T6', name: 'BG Champion loan to LLS Vote — Kim draft',
        status: 'to do', canon: 'To Do', due: SOD + 10 * DAY, space: LW.CMJ, spaceName: 'Chris Mitch Jay',
        list: '901414079253', listName: 'Chris Mitch List', assignees: [MITCH],
        priority: { id: 3, name: 'normal' }, intent: 'open only — 10 days out' }),
    T({ id: 'T7', name: 'Arbor Draw — Estrella/Sierra',
        status: 'complete', canon: 'Completed', type: 'closed', due: SOD - 5 * DAY, space: LW.AM,
        assignees: [JOHN], priority: { id: 1, name: 'urgent' },
        intent: 'completed only — past due but done, so NOT overdue' }),
    T({ id: 'T8', name: 'Boulder Bancroft',
        status: 'done', canon: 'Completed', type: 'closed', due: null, space: LW.AM,
        list: '901418084715', listName: 'Q2 2026', intent: 'completed only' }),
    T({ id: 'T9', name: 'Cordes',
        status: 'not reporting', canon: 'Long Term', due: null, space: LW.AM,
        list: '901418084715', listName: 'Q2 2026',
        intent: 'open — "not reporting" is unmapped in status-mappings.json and lands outside Completed' }),
    T({ id: 'T10', name: 'Quarterly Investor Reports',
        status: 'quarterly recurring', canon: 'Long Term', due: SOD + 40 * DAY, space: LW.AM,
        assignees: [BRIAN], priority: { id: 3, name: 'normal' }, intent: 'open only' }),
    T({ id: 'T11', name: 'AI Agent for Mitch (test case for rest of team)',
        status: 'in review', canon: 'In Review', due: SOD + 2 * DAY, space: LW.CMJ, spaceName: 'Chris Mitch Jay',
        list: '901417746413', listName: 'Jay Project Pipeline',
        assignees: [{ id: 94215376, username: 'Jay Delgado', initials: 'JD' }],
        priority: { id: 3, name: 'normal' }, intent: 'open, dueweek' }),
    T({ id: 'T12', name: 'Confirm UW with PM',
        status: 'in progress', canon: 'In Progress', due: SOD + DAY, space: LW.ACQ, spaceName: 'Acquisitions',
        list: '901402929836', listName: 'Prospective Properties', parent: 'T1',
        assignees: [JOHN], intent: 'open, dueweek — subtask of T1, must nest under it' }),
    T({ id: 'T13', name: 'Leadli ad spend review',
        status: 'to do', canon: 'To Do', due: SOD - DAY, space: LEADLI, spaceName: 'Leadli',
        intent: 'OUT OF SCOPE — Leadli space, must not appear in the LeavenWealth view at all' }),
    T({ id: 'T14', name: 'Colonial Soma LLC 10k distribution',
        status: 'to do', canon: 'To Do', due: SOD, space: LW.AM, assignees: [MITCH],
        intent: 'open, dueweek — due exactly at start of today, inclusive lower bound' }),
    T({ id: 'T15', name: 'VestMint distro tool',
        status: 'not started', canon: 'To Do', due: SOD + 7 * DAY, space: LW.CMJ, spaceName: 'Chris Mitch Jay',
        list: '901414079253', listName: 'Chris Mitch List', assignees: [MITCH],
        intent: 'open only — due exactly 7 days out, exclusive upper bound, so NOT dueweek' }),
  ];

  window.__FIXTURE = {
    tasks: tasks,
    members: [BRIAN, JOHN, MITCH],
    spaces: [],
    fetched_at: new Date(SOD).toISOString(),
    team_id: '9014303262',
    mode: 'fixture',
    count: tasks.length,
    from_cache: false,
  };
})();
