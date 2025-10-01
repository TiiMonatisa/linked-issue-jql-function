import api, { route } from '@forge/api';

/**
 * linked-issue-jql single-arg syntax:
 *   "linked: <JQL>"        -> issues linked to the seed issues
 *   "epic-of: <JQL>"       -> epics that are parents of the seed issues
 *   "subtasks-of: <JQL>"   -> subtasks of the seed issues
 *   "parent-of: <JQL>"     -> parents of the seed issues (any parent type)
 *   "<JQL>"                -> defaults to "linked"
 *
 * Examples:
 *   issue in linked-issue-jql("epic-of: issuetype = Task AND statusCategory = Done")
 *   issue in linked-issue-jql("linked: issuekey = ABC-123")
 *   issue in linked-issue-jql("subtasks-of: issuetype = Task AND project = ABC")
 *   issue in linked-issue-jql("parent-of: issuetype = Sub-task AND labels = foo")
 */

const SAFE_NO_MATCH = `issuekey = "__NO_MATCH__"`; // a clause that matches nothing

// ---------- tiny utils ----------
function buildIssueKeySetJql(keys, negate = false) {
  if (!keys || keys.size === 0) {
    return negate ? `issuekey != "__NO_MATCH__"` : SAFE_NO_MATCH;
  }
  const list = Array.from(keys)
      .map(k => `'${String(k).replace(/'/g, "\\'")}'`)
      .join(', ');
  return `issuekey ${negate ? 'not in' : 'in'} (${list})`;
}

function parseArg(raw) {
  const s = String(raw || '').trim();
  if (!s) return { mode: 'linked', innerJql: '' };
  const m = s.match(/^(epic-of|linked|subtasks-of|parent-of)\s*:\s*(.+)$/i);
  return m
      ? { mode: m[1].toLowerCase(), innerJql: m[2].trim() }
      : { mode: 'linked', innerJql: s };
}

// ---------- relationship extractors ----------
function extractLinkedIssueKeys(issues) {
  const out = new Set();
  for (const i of issues) {
    const links = i?.fields?.issuelinks || [];
    for (const l of links) {
      if (l?.outwardIssue?.key) out.add(l.outwardIssue.key);
      if (l?.inwardIssue?.key) out.add(l.inwardIssue.key);
    }
  }
  return out;
}

function extractParentKeys(issues) {
  // any parent (useful for "parent-of")
  const out = new Set();
  for (const i of issues) {
    const p = i?.fields?.parent;
    if (p?.key) out.add(p.key);
  }
  return out;
}

function extractParentEpicKeys(issues) {
  // prefer identifying Epic by hierarchyLevel/name; if unknown, still include the parent key
  const out = new Set();
  for (const i of issues) {
    const p = i?.fields?.parent;
    if (!p?.key) continue;
    const t = p?.fields?.issuetype;
    if (
        t?.hierarchyLevel === 1 ||
        String(t?.name || '').toLowerCase() === 'epic' ||
        !t // if fields not expanded, accept parent anyway to avoid false negatives
    ) {
      out.add(p.key);
    }
  }
  return out;
}

function extractSubtaskKeys(issues) {
  const out = new Set();
  for (const i of issues) {
    const subs = i?.fields?.subtasks || [];
    for (const s of subs) {
      if (s?.key) out.add(s.key);
    }
  }
  return out;
}

// ---------- search with Enhanced-JQL + fallback ----------
async function searchSeedIssues({ jql, wantedFields, pageCap = 4, pageSize = 100 }) {
  const issues = [];
  let nextPageToken;

  // Try Enhanced JQL: POST /rest/api/3/search/jql (no reconcileIssues unless you have numeric IDs)
  try {
    for (let page = 0; page < pageCap; page++) {
      const body = {
        jql,
        maxResults: pageSize,
        fields: wantedFields,
        ...(nextPageToken ? { nextPageToken } : {}),
      };

      const res = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status === 404) throw new Error('ENHANCED_JQL_NOT_AVAILABLE');
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Enhanced search failed: ${res.status} ${t}`);
      }

      const data = await res.json();
      issues.push(...(data.issues || []));
      if (!data.nextPageToken || data.isLast === true) break;
      nextPageToken = data.nextPageToken;
    }
    return issues;
  } catch (e) {
    if (!String(e.message).includes('ENHANCED_JQL_NOT_AVAILABLE')) throw e;
  }

  // Legacy fallback: GET /rest/api/3/search with startAt pagination
  let startAt = 0;
  for (let page = 0; page < pageCap; page++) {
    const qs =
        `jql=${encodeURIComponent(jql)}` +
        `&startAt=${startAt}` +
        `&maxResults=${pageSize}` +
        `&fields=${encodeURIComponent(wantedFields.join(','))}`;

    const res = await api.asApp().requestJira(route`/rest/api/3/search?${qs}`);
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Legacy search failed: ${res.status} ${t}`);
    }
    const data = await res.json();
    issues.push(...(data.issues || []));
    startAt += data.maxResults || pageSize;
    if (startAt >= (data.total || 0)) break;
  }
  return issues;
}

// ---------- MAIN Forge JQL function ----------
export const issuesWithText = async (args) => {
  console.log('Hello from issuesWithText()');
  const startedAt = Date.now();

  try {
    const { clause } = args || {};
    const operator = clause?.operator || 'in'; // 'in' | 'not in'
    const [arg0] = clause?.arguments || [];

    const { mode, innerJql } = parseArg(arg0);
    if (!innerJql) {
      console.warn('No inner JQL provided.');
      return { jql: SAFE_NO_MATCH };
    }

    // Keep field set small to minimize payload/timeouts.
    // Include everything needed for our extractors.
    const wantedFields = Array.from(
        new Set(['issuelinks', 'parent', 'issuetype', 'subtasks'])
    );

    // Cap to ~400 seed issues (4 pages × 100) to stay responsive
    const seedIssues = await searchSeedIssues({
      jql: innerJql,
      wantedFields,
      pageCap: 4,
      pageSize: 100,
    });

    let keys;
    switch (mode) {
      case 'epic-of':
        keys = extractParentEpicKeys(seedIssues);
        break;
      case 'subtasks-of':
        keys = extractSubtaskKeys(seedIssues);
        break;
      case 'parent-of':
        keys = extractParentKeys(seedIssues);
        break;
      case 'linked':
      default:
        keys = extractLinkedIssueKeys(seedIssues);
        break;
    }

    // Safety: cap returned list to keep the resulting JQL from exploding
    const limitedKeys = new Set(Array.from(keys).slice(0, 1000));

    const negate = operator !== 'in';
    const jqlFragment = buildIssueKeySetJql(limitedKeys, negate);

    console.log(
        `Done in ${Date.now() - startedAt}ms; mode=${mode}; seeds=${seedIssues.length}; resultKeys=${limitedKeys.size}`
    );
    return { jql: jqlFragment };
  } catch (err) {
    // Never throw — return a harmless JQL so Jira doesn't show the generic error
    console.error('Resolver error:', err?.message || err, err?.stack || '');
    return { jql: SAFE_NO_MATCH };
  }
};
