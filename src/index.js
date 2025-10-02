import api, { route } from '@forge/api';

/**
 * Single-argument syntax (examples):
 *
 *  parent: <JQL>
 *  epic-of: <JQL>
 *  linked: <JQL>
 *  linked[relates to]: <JQL>                 // specific link type (both directions)
 *  linked[blocks->outward]: <JQL>            // specific link, outward side
 *  linked[is blocked by->inward]: <JQL>      // specific link, inward side
 *  subtask: <JQL>
 *  substask: <JQL>                           // alias for subtask (typo-friendly)
 *
 *  // defaults to "linked" if no mode prefix is provided:
 *  <JQL>
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

// Parse the single argument into { mode, linkFilter, innerJql }
// - mode ∈ {'parent','epic-of','linked','subtask'}
// - linkFilter: { typeHint?: string, direction?: 'inward'|'outward' } (only for mode='linked')
// - innerJql: the JQL string to run as seed
function parseArg(raw) {
  const s = String(raw || '').trim();
  if (!s) return { mode: 'linked', innerJql: '' };

  // Pattern: mode [optional [linkType [-> direction]]] : innerJql
  // Examples:
  //  linked: project = ABC
  //  linked[relates to]: project = ABC
  //  linked[blocks->outward]: project = ABC
  const m = s.match(/^(parent|epic-of|linked|subtask|substask)(?:\s*\[\s*([^\]\-]+?)(?:\s*->\s*(inward|outward))?\s*\])?\s*:\s*(.+)$/i);
  if (m) {
    const modeRaw = m[1].toLowerCase();
    const mode = modeRaw === 'substask' ? 'subtask' : modeRaw;
    const typeHint = (m[2] || '').trim();
    const direction = (m[3] || '').toLowerCase();
    const innerJql = (m[4] || '').trim();

    const linkFilter = mode === 'linked' && (typeHint || direction)
        ? { typeHint, direction: direction === 'inward' || direction === 'outward' ? direction : undefined }
        : undefined;

    return { mode, linkFilter, innerJql };
  }

  // No explicit mode → default to linked
  return { mode: 'linked', innerJql: s };
}

// ---------- relationship extractors ----------
function extractLinkedIssueKeys(issues, linkFilter) {
  const out = new Set();
  const needFilter = !!linkFilter && (linkFilter.typeHint || linkFilter.direction);
  const typeHint = (linkFilter?.typeHint || '').toLowerCase().trim();
  const wantInward = linkFilter?.direction === 'inward';
  const wantOutward = linkFilter?.direction === 'outward';

  for (const i of issues) {
    const links = i?.fields?.issuelinks || [];
    for (const l of links) {
      const typeObj = l?.type || {};
      // Jira gives: type.name (e.g., "Blocks"), type.inward (e.g., "is blocked by"), type.outward (e.g., "blocks")
      const tName = String(typeObj.name || '').toLowerCase().trim();
      const tIn = String(typeObj.inward || '').toLowerCase().trim();
      const tOut = String(typeObj.outward || '').toLowerCase().trim();

      // Determine whether this link passes the filter (if any)
      let pass = true;
      if (needFilter) {
        // If a typeHint is provided, match it against ANY of the display strings
        if (typeHint) {
          const matchesType = tName === typeHint || tIn === typeHint || tOut === typeHint;
          if (!matchesType) pass = false;
        }
      }

      // Add keys, respecting direction if requested
      // outwardIssue exists when current issue is the inward side, and vice versa.
      if (pass) {
        if (l?.outwardIssue?.key && (!needFilter || wantOutward || (!wantInward && !wantOutward))) {
          out.add(l.outwardIssue.key);
        }
        if (l?.inwardIssue?.key && (!needFilter || wantInward || (!wantInward && !wantOutward))) {
          out.add(l.inwardIssue.key);
        }
      }
    }
  }
  return out;
}

function extractParentKeys(issues) {
  const out = new Set();
  for (const i of issues) {
    const p = i?.fields?.parent;
    if (p?.key) out.add(p.key);
  }
  return out;
}

function extractParentEpicKeys(issues) {
  // identify an Epic parent by hierarchyLevel/name; if fields aren't expanded, still include parent key
  const out = new Set();
  for (const i of issues) {
    const p = i?.fields?.parent;
    if (!p?.key) continue;
    const t = p?.fields?.issuetype;
    if (
        t?.hierarchyLevel === 1 ||
        String(t?.name || '').toLowerCase() === 'epic' ||
        !t // include if unknown to avoid false negatives
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

  // Try Enhanced JQL: POST /rest/api/3/search/jql
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

    const { mode, linkFilter, innerJql } = parseArg(arg0);
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
      case 'parent':
        keys = extractParentKeys(seedIssues);
        break;
      case 'epic-of':
        keys = extractParentEpicKeys(seedIssues);
        break;
      case 'subtask':
        keys = extractSubtaskKeys(seedIssues);
        break;
      case 'linked':
      default:
        keys = extractLinkedIssueKeys(seedIssues, linkFilter);
        break;
    }

    // Safety: cap returned list to keep the resulting JQL from exploding
    const limitedKeys = new Set(Array.from(keys).slice(0, 1000));

    const negate = operator !== 'in';
    const jqlFragment = buildIssueKeySetJql(limitedKeys, negate);

    console.log(
        `Done in ${Date.now() - startedAt}ms; mode=${mode}; seeds=${seedIssues.length}; resultKeys=${limitedKeys.size}; filter=${JSON.stringify(linkFilter || null)}`
    );
    return { jql: jqlFragment };
  } catch (err) {
    // Never throw — return a harmless JQL so Jira doesn't show the generic error
    console.error('Resolver error:', err?.message || err, err?.stack || '');
    return { jql: SAFE_NO_MATCH };
  }
};
