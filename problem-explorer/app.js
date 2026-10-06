(function () {
  'use strict';

  var Q_COLORS = {
    Q1: '#0f71fa',
    Q2: '#757d82',
    Q3: '#e36b2c',
    Q4: '#dc2b28',
    Q5: '#8a4de8',
    Q7: '#876445',
    Q10: '#c48a00',
    Q_EV: '#1b7f4e',
    Q_lane: '#0d7377',
    Q_oneway: '#9b2226',
    Q_map: '#7a3e00',
    Q_feedback: '#c43b8c',
    H1: '#4264fb',
    H2: '#9b2226'
  };
  var SEV_RANK = { high: 0, medium: 1, low: 2, info: 3 };
  var TAGS = [
    { id: 'true_detection', label: 'True Detection', short: 'True Detection' },
    { id: 'false_positive', label: 'False positive detection', short: 'False positive' },
    { id: 'na', label: 'N/A', short: 'N/A' }
  ];
  var REVIEWER_KEY = 'trace-board-reviewer';
  var LAST_POS_KEY = 'trace-problem-last-pos-v1';
  var LIST_CAP = 3000;

  var state = {
    problems: [],
    overlay: null,
    category: '',
    qCode: '',
    selectedId: null,
    traceFile: '',
    sourceName: 'bundled snapshot',
    markersById: {},
    cluster: null,
    shouldFit: true,
    expandedTraces: {},
    litPlaces: {},
    showAlsoId: '',
    reviews: {},
    reviewLive: false,
    reviewError: ''
  };

  var map, overlayLayer;

  function $(id) { return document.getElementById(id); }

  function hasGeo(p) {
    return p.lat != null && p.lon != null && p.lat !== '' && p.lon !== '' &&
      isFinite(Number(p.lat)) && isFinite(Number(p.lon));
  }

  function qColor(q) { return Q_COLORS[q] || '#4d5255'; }

  function reviewOf(id) {
    return state.reviews[id] || null;
  }

  function tagMeta(id) {
    for (var i = 0; i < TAGS.length; i++) {
      if (TAGS[i].id === id) return TAGS[i];
    }
    return null;
  }

  function tagLabel(id) {
    var meta = tagMeta(id);
    return meta ? meta.label : id;
  }

  function reviewerName() {
    var el = $('reviewer-name');
    var name = el ? String(el.value || '').trim() : '';
    if (!name) {
      try { name = String(localStorage.getItem(REVIEWER_KEY) || '').trim(); } catch (e) {}
    }
    return name;
  }

  function unique(list, key) {
    var seen = {};
    var out = [];
    list.forEach(function (item) {
      var v = item[key];
      if (v && !seen[v]) { seen[v] = true; out.push(v); }
    });
    out.sort();
    return out;
  }

  function fillSelect(sel, values, extraLabel) {
    var keep = sel.value;
    sel.innerHTML = '';
    var all = document.createElement('option');
    all.value = '';
    all.textContent = extraLabel;
    sel.appendChild(all);
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    });
    if (values.indexOf(keep) !== -1) sel.value = keep;
  }

  function parseCsv(text) {
    var rows = [];
    var row = [];
    var cell = '';
    var inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      var n = text[i + 1];
      if (inQuotes) {
        if (c === '"' && n === '"') { cell += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else cell += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && n === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    if (!rows.length) return [];
    var header = rows[0].map(function (h) { return h.trim(); });
    return rows.slice(1).filter(function (r) { return r.some(Boolean); }).map(function (r) {
      var obj = {};
      header.forEach(function (h, idx) { obj[h] = r[idx] == null ? '' : r[idx]; });
      if (obj.metadata_json && !obj.metadata) {
        try { obj.metadata = JSON.parse(obj.metadata_json); } catch (e) { obj.metadata = {}; }
      }
      if (obj.lat === '') obj.lat = null;
      if (obj.lon === '') obj.lon = null;
      if (obj.lat != null) obj.lat = Number(obj.lat);
      if (obj.lon != null) obj.lon = Number(obj.lon);
      return obj;
    });
  }

  function fromGeojson(fc) {
    var features = (fc && fc.features) || [];
    var problems = [];
    var overlay = [];
    features.forEach(function (f) {
      var props = f.properties || {};
      var coords = f.geometry && f.geometry.coordinates;
      var lon = coords ? coords[0] : props.lon;
      var lat = coords ? coords[1] : props.lat;
      if (props.problem_id || props.q_code) {
        var rec = Object.assign({}, props);
        rec.lat = lat;
        rec.lon = lon;
        if (typeof rec.metadata === 'string') {
          try { rec.metadata = JSON.parse(rec.metadata); } catch (e) {}
        }
        problems.push(rec);
      } else {
        overlay.push(f);
      }
    });
    return { problems: problems, overlay: overlay.length ? { type: 'FeatureCollection', features: overlay } : null };
  }

  var EXCLUDED_TRACE_PREFIXES = [
    '2026-09-18T14_11_48.790Z__2026-09-18T15_24_28.220Z__'
  ];

  function isExcludedTrace(p) {
    var key = String((p && (p.trace_file || p.report_file)) || '');
    for (var i = 0; i < EXCLUDED_TRACE_PREFIXES.length; i++) {
      if (key.indexOf(EXCLUDED_TRACE_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  function ingest(payload, name) {
    var problems = [];
    var overlay = null;
    if (typeof payload === 'string') {
      var trimmed = payload.replace(/^\uFEFF/, '').trim();
      if (trimmed.indexOf('window.TRACE_PROBLEMS') === 0) {
        trimmed = trimmed.replace(/^window\.TRACE_PROBLEMS\s*=\s*/, '').replace(/;\s*$/, '');
      }
      if (trimmed.charAt(0) === '[' || trimmed.charAt(0) === '{') payload = JSON.parse(trimmed);
      else payload = parseCsv(trimmed);
    }
    if (Array.isArray(payload)) problems = payload;
    else if (payload && payload.type === 'FeatureCollection') {
      var parsed = fromGeojson(payload);
      problems = parsed.problems;
      overlay = parsed.overlay;
      if (!problems.length && payload.features && payload.features.length) overlay = payload;
    } else if (payload && Array.isArray(payload.findings)) problems = payload.findings;
    else if (payload && Array.isArray(payload.problems)) problems = payload.problems;

    problems = problems.filter(function (p) { return !isExcludedTrace(p) && !hideProblemType(p); });
    problems.forEach(function (p) {
      if (p.problem_type === 'stale_incident') p.problem_type = 'outdate_incident';
    });
    markRepeatPlaces(problems);
    if (problems.length) {
      state.problems = problems;
      state.sourceName = name || 'uploaded file';
      state.selectedId = null;
      state.traceFile = '';
    }
    if (overlay) {
      state.overlay = overlay;
      $('overlay-status').textContent = 'Overlay: ' + overlay.features.length + ' extra features';
    }
    if (problems.length) bootUi();
    else if (overlay) drawOverlay();
  }

  function currentFilters() {
    return {
      search: $('search').value.trim().toLowerCase(),
      type: $('filter-type').value,
      severity: $('filter-severity').value,
      sort: $('filter-sort').value,
      label: $('filter-label').value,
      project: $('filter-project').value,
      platform: $('filter-platform').value,
      vehicle: $('filter-vehicle').value.trim().toLowerCase(),
      user: $('filter-user').value.trim().toLowerCase(),
      from: $('filter-from').value,
      to: $('filter-to').value,
      geoOnly: $('filter-geo').checked,
      category: state.category,
      qCode: state.qCode
    };
  }

  function matches(p, f) {
    if (hideDividedOneway(p) || hideUnlimitedSpeedLimit(p) || hideProblemType(p)) return false;
    if (f.category && p.category !== f.category) return false;
    if (f.qCode && p.q_code !== f.qCode) return false;
    if (f.type && p.problem_type !== f.type) return false;
    if (f.severity && p.severity !== f.severity) return false;
    if (f.project && p.project !== f.project) return false;
    if (f.platform && p.platform !== f.platform) return false;
    if (f.geoOnly && !hasGeo(p)) return false;
    if (f.vehicle && String(p.vehicle || '').toLowerCase().indexOf(f.vehicle) === -1) return false;
    if (f.user && String(p.user_id || '').toLowerCase().indexOf(f.user) === -1) return false;
    if (f.from && (p.timestamp_utc || '') < f.from) return false;
    if (f.to && (p.timestamp_utc || '') > (f.to + 'T23:59:59Z')) return false;
    var tag = (reviewOf(p.problem_id) || {}).tag || '';
    if (f.label === 'untagged' && tag) return false;
    if (f.label && f.label !== 'untagged' && tag !== f.label) return false;
    if (f.search) {
      var blob = ((p.summary || '') + ' ' + (p.problem_id || '') + ' ' + (p.problem_type || '')).toLowerCase();
      if (blob.indexOf(f.search) === -1) return false;
    }
    if (state.traceFile && traceKey(p) !== state.traceFile) return false;
    return true;
  }

  function hideDividedOneway(p) {
    if (!p || p.problem_type !== 'oneway_against') return false;
    var way = String((p.metadata && p.metadata.osm_way) || '');
    return /(^|[\s;#])A\s*\d/.test(way) || /(^|[\s;#])B\s*\d/.test(way);
  }

  function hideUnlimitedSpeedLimit(p) {
    if (!p || String(p.problem_type || '').indexOf('speed_limit') !== 0) return false;
    var blob = ((p.summary || '') + ' ' + JSON.stringify(p.metadata || {})).toLowerCase();
    return /255\s*km\/h/.test(blob) || /"speed"\s*:\s*255/.test(blob);
  }

  function hideProblemType(p) {
    if (!p) return false;
    var hidden = {
      unmapped_closure: true,
      route_incident: true,
      map_matcher_teleport: true,
      navigator_fallback: true,
      net_eta_impact: true,
      tunnel_degraded: true
    };
    return !!hidden[p.problem_type];
  }

  function traceKey(p) {
    return (p && (p.trace_file || p.report_file)) || '';
  }

  function findingsForTrace(key) {
    return state.problems.filter(function (p) { return traceKey(p) === key; });
  }

  function meta(p) {
    return (p && p.metadata && typeof p.metadata === 'object') ? p.metadata : {};
  }

  function parseMeters(text) {
    var s = String(text == null ? '' : text);
    var km = s.match(/(-?[\d.]+)\s*km\b/i);
    if (km) return parseFloat(km[1]) * 1000;
    var m = s.match(/(-?[\d.]+)\s*m\b/i);
    if (m) return parseFloat(m[1]);
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  function parseDurationSec(text) {
    var s = String(text == null ? '' : text);
    if (!s || /^n\/?a$/i.test(s.trim()) || s.trim() === '—') return null;
    var sec = 0;
    var found = false;
    var h = s.match(/(\d+)\s*h/i);
    var min = s.match(/(\d+)\s*m(?!s)/i);
    var secM = s.match(/(\d+)\s*s\b/i);
    if (h) { sec += parseInt(h[1], 10) * 3600; found = true; }
    if (min) { sec += parseInt(min[1], 10) * 60; found = true; }
    if (secM) { sec += parseInt(secM[1], 10); found = true; }
    return found ? sec : null;
  }

  function parseSignedDurationSec(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s || /^n\/?a$/i.test(s)) return null;
    var sign = s.charAt(0) === '-' ? -1 : 1;
    var mag = parseDurationSec(s.replace(/^[+-]/, ''));
    return mag == null ? null : sign * mag;
  }

  function parseKwhAbs(text) {
    var m = String(text == null ? '' : text).match(/([+-]?[\d.]+)\s*kWh/i);
    if (!m) return null;
    return Math.abs(parseFloat(m[1]));
  }

  function metricDivergenceM(p) {
    return parseMeters(meta(p)['worst dist'] || p.summary);
  }

  function metricLastingSec(p) {
    return parseDurationSec(meta(p).duration);
  }

  function metricPoorM(p) {
    return parseMeters(meta(p).distance_from_destination || p.summary);
  }

  function metricEtaSec(p) {
    var raw = meta(p)['eta impact'] || meta(p).net_eta_impact || p.summary;
    var v = parseSignedDurationSec(raw);
    return v == null ? null : Math.abs(v);
  }

  function metricSocKwh(p) {
    return parseKwhAbs(meta(p).arrival_prediction_error || meta(p).mean_prediction_error || p.summary);
  }

  function metricIncidentM(p) {
    return parseMeters(meta(p).length);
  }

  function metricOverpredGap(p) {
    var exp = parseFloat(meta(p)['expected (km/h)']);
    var act = parseFloat(meta(p)['actual (km/h)']);
    if (!isFinite(exp) || !isFinite(act)) return parseDurationSec(meta(p).duration);
    return act - exp;
  }

  function cmpNum(a, b, dir) {
    var an = a == null || !isFinite(a);
    var bn = b == null || !isFinite(b);
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    if (a === b) return 0;
    return dir < 0 ? (b - a) : (a - b);
  }

  function compareMetric(a, b, mode) {
    var dir = mode.indexOf('_asc') !== -1 ? 1 : -1;
    if (mode === 'div_desc' || mode === 'div_asc') {
      var d = cmpNum(metricDivergenceM(a), metricDivergenceM(b), dir);
      if (d !== 0) return d;
      return cmpNum(metricLastingSec(a), metricLastingSec(b), dir);
    }
    if (mode === 'poor_desc' || mode === 'poor_asc') return cmpNum(metricPoorM(a), metricPoorM(b), dir);
    if (mode === 'eta_desc' || mode === 'eta_asc') return cmpNum(metricEtaSec(a), metricEtaSec(b), dir);
    if (mode === 'soc_desc' || mode === 'soc_asc') return cmpNum(metricSocKwh(a), metricSocKwh(b), dir);
    if (mode === 'incident_desc' || mode === 'incident_asc') return cmpNum(metricIncidentM(a), metricIncidentM(b), dir);
    if (mode === 'overpred_desc' || mode === 'overpred_asc') return cmpNum(metricOverpredGap(a), metricOverpredGap(b), dir);
    return 0;
  }

  function metricHint(p, mode) {
    var kind = hintKind(p, mode);
    if (kind === 'div') {
      var dist = meta(p)['worst dist'];
      var dur = meta(p).duration;
      if (dist || dur) return [dist, dur].filter(Boolean).join(' · ');
    }
    if (kind === 'poor') return meta(p).distance_from_destination || '';
    if (kind === 'eta') return meta(p)['eta impact'] || meta(p).net_eta_impact || '';
    if (kind === 'soc') return meta(p).arrival_prediction_error || meta(p).mean_prediction_error || '';
    if (kind === 'incident') return meta(p).length || '';
    if (kind === 'overpred') {
      var exp = meta(p)['expected (km/h)'];
      var act = meta(p)['actual (km/h)'];
      if (exp && act) return act + ' vs ' + exp + ' km/h';
      return meta(p).duration || '';
    }
    return '';
  }

  function hintKind(p, mode) {
    if (mode.indexOf('div_') === 0 || p.problem_type === 'gps_divergence') return 'div';
    if (mode.indexOf('poor_') === 0 || p.problem_type === 'poor_arrival') return 'poor';
    if (mode.indexOf('eta_') === 0 || p.problem_type === 'route_change' || p.problem_type === 'off_route' || p.problem_type === 'net_eta_impact') return 'eta';
    if (mode.indexOf('soc_') === 0 || p.problem_type === 'soc_arrival_error' || p.problem_type === 'soc_prediction_error') return 'soc';
    if (mode.indexOf('incident_') === 0 || p.problem_type === 'route_incident') return 'incident';
    if (mode.indexOf('overpred_') === 0 || p.problem_type === 'congestion_signal') return 'overpred';
    return '';
  }

  function suggestedSort() {
    var type = $('filter-type').value;
    var byType = {
      gps_divergence: 'div_desc',
      poor_arrival: 'poor_desc',
      route_change: 'eta_desc',
      off_route: 'eta_desc',
      net_eta_impact: 'eta_desc',
      soc_arrival_error: 'soc_desc',
      soc_prediction_error: 'soc_desc',
      route_incident: 'incident_desc',
      congestion_signal: 'overpred_desc'
    };
    if (byType[type]) return byType[type];
    var byQ = { Q4: 'div_desc', Q2: 'poor_desc', Q1: 'eta_desc', Q_EV: 'soc_desc', Q10: 'incident_desc', Q3: 'overpred_desc' };
    if (byQ[state.qCode]) return byQ[state.qCode];
    var byCat = {
      gps_divergence: 'div_desc',
      route_completion: 'poor_desc',
      route_changes: 'eta_desc',
      ev: 'soc_desc',
      route_incidents: 'incident_desc',
      traffic: 'overpred_desc'
    };
    return byCat[state.category] || null;
  }

  function setSort(mode) {
    if ($('filter-sort')) $('filter-sort').value = mode;
    if ($('list-sort')) $('list-sort').value = mode;
  }

  function applySuggestedSort() {
    var next = suggestedSort();
    if (!next) return;
    var cur = $('filter-sort').value;
    var family = next.replace(/_asc|_desc/, '');
    if (cur.indexOf(family + '_') === 0) return;
    setSort(next);
  }

  function filtered() {
    var f = currentFilters();
    var rows = state.problems.filter(function (p) { return matches(p, f); });
    var mode = f.sort || 'severity';
    if (!state.traceFile) {
      rows = rows.filter(function (p) { return !p.repeat_drop; });
    }
    rows.sort(function (a, b) {
      if (mode === 'time') return String(b.timestamp_utc || '').localeCompare(String(a.timestamp_utc || ''));
      if (mode === 'q') return String(a.q_code || '').localeCompare(String(b.q_code || ''));
      if (mode !== 'severity') {
        var md = compareMetric(a, b, mode);
        if (md !== 0) return md;
        return String(b.timestamp_utc || '').localeCompare(String(a.timestamp_utc || ''));
      }
      var ds = (SEV_RANK[a.severity] || 9) - (SEV_RANK[b.severity] || 9);
      if (ds !== 0) return ds;
      return String(b.timestamp_utc || '').localeCompare(String(a.timestamp_utc || ''));
    });
    groupByPlace(rows);
    return rows;
  }

  function repeatLabel(p) {
    var n = p && p.seen_traces || 0;
    if (n < 2) return '';
    var other = n - 1;
    return 'also in ' + other + (other === 1 ? ' trace' : ' traces');
  }

  function otherTraceFiles(p) {
    var files = (p && p.repeat_files) || [];
    var mine = traceKey(p);
    return files.filter(function (file) { return file && file !== mine; });
  }

  function alsoFilesHtml(p) {
    var files = otherTraceFiles(p);
    if (!files.length || state.showAlsoId !== p.problem_id) return '';
    return '<div class="also-files txt-xs">' +
      files.map(function (file) {
        return '<div class="also-file">' + escapeHtml(file) + '</div>';
      }).join('') +
      '</div>';
  }

  function markRepeatPlaces(rows) {
    rows.forEach(function (p) {
      delete p.seen_traces;
      delete p.repeat_files;
      delete p.repeat_drop;
    });
    var pool = rows.filter(function (p) {
      return !hideDividedOneway(p) && !hideUnlimitedSpeedLimit(p);
    });
    stampTraceGroups(pool, function (p) {
      return p.problem_type === 'gps_divergence' && hasGeo(p);
    }, function (a, b) {
      var d = distM(Number(a.lat), Number(a.lon), Number(b.lat), Number(b.lon));
      if (d <= 30) return true;
      if (d > 60) return false;
      var da = metricDivergenceM(a);
      var db = metricDivergenceM(b);
      return da != null && db != null && Math.abs(da - db) <= 8;
    });
    stampTraceGroups(pool, function (p) {
      return p.problem_type !== 'gps_divergence' && hasGeo(p);
    }, function (a, b) {
      if ((a.problem_type || '') !== (b.problem_type || '')) return false;
      return distM(Number(a.lat), Number(a.lon), Number(b.lat), Number(b.lon)) <= 15;
    });
  }

  function stampTraceGroups(rows, take, closeEnough) {
    var parent = [];
    for (var i = 0; i < rows.length; i++) parent[i] = i;
    function find(i) {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    }
    function unite(a, b) {
      var ra = find(a);
      var rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }
    var geoIdx = [];
    for (var i = 0; i < rows.length; i++) {
      if (take(rows[i])) geoIdx.push(i);
    }
    for (var a = 0; a < geoIdx.length; a++) {
      var pa = rows[geoIdx[a]];
      for (var b = a + 1; b < geoIdx.length; b++) {
        var pb = rows[geoIdx[b]];
        var ta = traceKey(pa);
        var tb = traceKey(pb);
        if (ta && tb && ta === tb) continue;
        if (closeEnough(pa, pb)) unite(geoIdx[a], geoIdx[b]);
      }
    }
    var groups = {};
    geoIdx.forEach(function (i) {
      var root = find(i);
      if (!groups[root]) groups[root] = [];
      groups[root].push(i);
    });
    Object.keys(groups).forEach(function (k) {
      var members = groups[k];
      if (members.length < 2) return;
      var traces = {};
      members.forEach(function (i) {
        traces[traceKey(rows[i]) || rows[i].problem_id] = 1;
      });
      var count = Object.keys(traces).length;
      if (count < 2) return;
      var best = members[0];
      members.forEach(function (i) {
        if (repeatKeepScore(rows[i]) > repeatKeepScore(rows[best])) best = i;
      });
      var keeperTrace = traceKey(rows[best]);
      var names = Object.keys(traces);
      members.forEach(function (i) {
        rows[i].seen_traces = count;
        rows[i].repeat_files = names;
        if (traceKey(rows[i]) !== keeperTrace) rows[i].repeat_drop = true;
      });
    });
  }

  function repeatKeepScore(p) {
    if (p.problem_type === 'gps_divergence') return metricDivergenceM(p) || 0;
    var sev = p.severity === 'high' ? 3 : (p.severity === 'medium' ? 2 : 1);
    var meters = parseMeters((p.metadata || {}).distance || (p.metadata || {}).length || (p.metadata || {})['worst dist'] || '');
    return sev * 100000 + (meters || 0);
  }

  function distM(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // Same problem_type within 100 m is one place. Neighbors of neighbors merge too,
  // so two hits a few meters apart stay together even if each first joined a different group.
  var PLACE_M = 100;
  var placeKeyById = {};

  function groupByPlace(rows) {
    var n = rows.length;
    var parent = [];
    for (var i = 0; i < n; i++) parent.push(i);
    function find(i) {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    }
    function unite(a, b) {
      a = find(a);
      b = find(b);
      if (a !== b) parent[b] = a;
    }
    var geo = [];
    for (var g = 0; g < n; g++) {
      if (hasGeo(rows[g])) geo.push(g);
    }
    for (var a = 0; a < geo.length; a++) {
      var ia = geo[a];
      var pa = rows[ia];
      var ta = pa.problem_type || pa.q_code || '';
      for (var b = a + 1; b < geo.length; b++) {
        var ib = geo[b];
        var pb = rows[ib];
        if ((pb.problem_type || pb.q_code || '') !== ta) continue;
        if (distM(Number(pa.lat), Number(pa.lon), Number(pb.lat), Number(pb.lon)) <= PLACE_M) unite(ia, ib);
      }
    }
    placeKeyById = {};
    var clusters = [];
    var byRoot = {};
    for (var r = 0; r < n; r++) {
      var p = rows[r];
      var root = find(r);
      var hit = byRoot[root];
      if (!hit) {
        var lat = Number(p.lat);
        var lon = Number(p.lon);
        var has = hasGeo(p);
        var type = p.problem_type || p.q_code || '';
        hit = {
          type: type,
          lat: has ? lat : null,
          lon: has ? lon : null,
          items: [],
          traces: {},
          key: has ? (type + '@' + lat.toFixed(4) + ',' + lon.toFixed(4)) : (type + '@none:' + (p.problem_id || clusters.length))
        };
        byRoot[root] = hit;
        clusters.push(hit);
      }
      hit.items.push(p);
      var tk = traceKey(p);
      if (tk) hit.traces[tk] = 1;
      placeKeyById[p.problem_id] = hit.key;
    }
    state.placeMeta = {};
    var out = [];
    clusters.forEach(function (c, i) {
      state.placeMeta[c.key] = {
        type: c.type,
        lat: c.lat,
        lon: c.lon,
        count: c.items.length,
        traces: Object.keys(c.traces).length,
        n: i + 1,
        total: clusters.length
      };
      c.items.forEach(function (p) { out.push(p); });
    });
    return rows;
  }

  function shortTraceLabel(key) {
    var name = String(key || '').replace(/\.pbf\.gz$/i, '');
    var start = (name.match(/^\d{4}-\d{2}-\d{2}T[\d_:.]+Z/) || [''])[0].replace(/_/g, ':');
    var uuid = (name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [''])[0];
    if (start && uuid) return start + ' · ' + uuid.slice(0, 8);
    return name.slice(0, 48) || 'Unknown trace';
  }

  function counts(list) {
    var byQ = {};
    var bySev = { high: 0, medium: 0, low: 0 };
    var byCat = {};
    var geo = 0;
    var tags = { true_detection: 0, false_positive: 0, na: 0 };
    var tagged = 0;
    list.forEach(function (p) {
      byQ[p.q_code] = (byQ[p.q_code] || 0) + 1;
      bySev[p.severity] = (bySev[p.severity] || 0) + 1;
      byCat[p.category] = (byCat[p.category] || 0) + 1;
      if (hasGeo(p)) geo += 1;
      var rec = reviewOf(p.problem_id);
      if (rec && tags[rec.tag] != null) {
        tags[rec.tag] += 1;
        tagged += 1;
      }
    });
    return { byQ: byQ, bySev: bySev, byCat: byCat, geo: geo, tags: tags, tagged: tagged, n: list.length };
  }

  function kpiCard(label, value, hint) {
    return '<div class="col w-full w-1/2-mm w-1/4-ml mb12"><div class="card py18 px18">' +
      '<div class="txt-s color-gray mb6">' + label + '</div>' +
      '<div class="display-3 txt-bold color-gray-dark">' + value + '</div>' +
      (hint ? '<div class="txt-s color-gray mt6">' + hint + '</div>' : '') +
      '</div></div>';
  }

  function renderKpis(all, vis) {
    var cAll = counts(all);
    var cVis = counts(vis);
    $('kpi-row').innerHTML =
      kpiCard('Findings', cVis.n.toLocaleString(), 'of ' + cAll.n.toLocaleString() + ' loaded') +
      kpiCard('With coordinates', cVis.geo.toLocaleString(), cAll.geo.toLocaleString() + ' in snapshot') +
      kpiCard('High severity', (cVis.bySev.high || 0).toLocaleString(), 'medium ' + (cVis.bySev.medium || 0)) +
      kpiCard('Tagged', cVis.tagged.toLocaleString(), 'of ' + cVis.n.toLocaleString() + ' in this filter');
  }

  function renderQChips(all) {
    var c = counts(all).byQ;
    var keys = Object.keys(c).sort();
    var html = '<button type="button" class="btn btn--s btn-pill px12 mr6 mb6 q-chip' + (state.qCode ? ' btn--stroke' : '') + '" data-q="">All Q</button>';
    keys.forEach(function (q) {
      var active = state.qCode === q;
      html += '<button type="button" class="btn btn--s btn-pill px12 mr6 mb6 q-chip' + (active ? '' : ' btn--stroke') + '" data-q="' + q + '">' +
        '<span class="legend-swatch" style="background:' + qColor(q) + '"></span>' + q + ' · ' + c[q] + '</button>';
    });
    $('q-chips').innerHTML = html;
  }

  function renderTabs(all) {
    var c = counts(all).byCat;
    var keys = Object.keys(c).sort();
    var html = '<button type="button" class="btn btn--s btn-pill px18 mr6 mb6 cat-tab' + (state.category ? ' btn--stroke' : '') + '" data-cat="">All</button>';
    keys.forEach(function (cat) {
      var active = state.category === cat;
      html += '<button type="button" class="btn btn--s btn-pill px18 mr6 mb6 cat-tab' + (active ? '' : ' btn--stroke') + '" data-cat="' + cat + '">' +
        cat.replace(/_/g, ' ') + ' · ' + c[cat] + '</button>';
    });
    $('category-tabs').innerHTML = html;
  }

  function pinIcon(p, selected) {
    var size = p.severity === 'high' ? 16 : p.severity === 'medium' ? 13 : 11;
    if (selected) size += 4;
    var color = qColor(p.q_code);
    return L.divIcon({
      className: '',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      html: '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:' + color +
        ';border:2px solid #fff;box-shadow:0 0 0 ' + (selected ? '2px #0f71fa' : '1px rgba(14,16,18,.25)') + '"></div>'
    });
  }

  function popupHtml(p) {
    var repeat = repeatLabel(p);
    return '<div class="txt-s txt-bold mb6">' + escapeHtml(p.problem_type || p.q_code) +
      ' · ' + escapeHtml(p.severity || '') +
      (repeat ? ' <span class="repeat-mark">' + escapeHtml(repeat) + '</span>' : '') + '</div>' +
      '<div class="txt-s mb6">' + escapeHtml(p.summary || '') + '</div>' +
      '<div class="txt-xs color-gray txt-mono">' + escapeHtml(p.problem_id || '') + '</div>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function ensureMap() {
    if (map) return;
    map = L.map('map', { scrollWheelZoom: true }).setView([48.78, 9.18], 7);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);
    overlayLayer = L.layerGroup().addTo(map);
    setTimeout(function () { map.invalidateSize(); }, 80);
  }

  function drawOverlay() {
    if (!overlayLayer) return;
    overlayLayer.clearLayers();
    if (!state.overlay) return;
    L.geoJSON(state.overlay, {
      pointToLayer: function (feat, latlng) {
        var color = (feat.properties && feat.properties.color) || '#4264fb';
        return L.circleMarker(latlng, { radius: 7, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.9 });
      },
      onEachFeature: function (feat, layer) {
        var p = feat.properties || {};
        layer.bindPopup('<div class="txt-s txt-bold">' + escapeHtml(p.label || 'overlay') + '</div>' +
          '<div class="txt-s">' + escapeHtml(p.notes || '') + '</div>');
      }
    }).addTo(overlayLayer);
  }

  function latLngsFromLine(line) {
    if (!line || line.length < 2) return null;
    return line.map(function (pair) { return [Number(pair[1]), Number(pair[0])]; });
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    var r = 6371000;
    var p1 = lat1 * Math.PI / 180;
    var p2 = lat2 * Math.PI / 180;
    var dphi = (lat2 - lat1) * Math.PI / 180;
    var dl = (lon2 - lon1) * Math.PI / 180;
    var h = Math.sin(dphi / 2) * Math.sin(dphi / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Short stretch around the pin. GPS divergence uses about 80 m each way.
  function clipAroundPin(line, lat, lon, halfM) {
    var pts = latLngsFromLine(line);
    if (!pts || lat == null || lon == null) return null;
    var best = 0;
    var bestD = Infinity;
    for (var i = 0; i < pts.length; i++) {
      var d = haversineM(pts[i][0], pts[i][1], lat, lon);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (halfM == null) halfM = 80;
    var from = best;
    var to = best;
    var accL = 0;
    var accR = 0;
    while (from > 0) {
      var stepL = haversineM(pts[from][0], pts[from][1], pts[from - 1][0], pts[from - 1][1]);
      if (accL + stepL > halfM) break;
      accL += stepL;
      from--;
    }
    while (to < pts.length - 1) {
      var stepR = haversineM(pts[to][0], pts[to][1], pts[to + 1][0], pts[to + 1][1]);
      if (accR + stepR > halfM) break;
      accR += stepR;
      to++;
    }
    if (to === from) {
      from = Math.max(0, best - 1);
      to = Math.min(pts.length - 1, best + 1);
    }
    if (to - from < 1) return null;
    return pts.slice(from, to + 1);
  }

  function divergenceRowsForLines(rows) {
    var typeOn = $('filter-type') && $('filter-type').value === 'gps_divergence';
    if (typeOn) {
      return rows.filter(function (p) { return p.problem_type === 'gps_divergence'; });
    }
    var lit = state.litPlaces || {};
    var keys = Object.keys(lit);
    if (keys.length) {
      return rows.filter(function (p) {
        return p.problem_type === 'gps_divergence' && lit[placeKeyById[p.problem_id]];
      });
    }
    if (!state.selectedId) return [];
    return rows.filter(function (p) {
      return p.problem_id === state.selectedId && p.problem_type === 'gps_divergence';
    });
  }

  function offRouteRows(rows) {
    var typeOn = $('filter-type') && $('filter-type').value === 'off_route';
    if (typeOn) return rows.filter(function (p) { return p.problem_type === 'off_route'; });
    var lit = state.litPlaces || {};
    var keys = Object.keys(lit);
    if (keys.length) {
      return rows.filter(function (p) {
        return p.problem_type === 'off_route' && lit[placeKeyById[p.problem_id]];
      });
    }
    if (!state.selectedId) return [];
    return rows.filter(function (p) {
      return p.problem_id === state.selectedId && p.problem_type === 'off_route';
    });
  }

  function missedRoadRows(rows) {
    var typeOn = $('filter-type') && $('filter-type').value === 'missed_road';
    if (typeOn) return rows.filter(function (p) { return p.problem_type === 'missed_road'; });
    var lit = state.litPlaces || {};
    var keys = Object.keys(lit);
    if (keys.length) {
      return rows.filter(function (p) {
        return p.problem_type === 'missed_road' && lit[placeKeyById[p.problem_id]];
      });
    }
    if (!state.selectedId) return [];
    return rows.filter(function (p) {
      return p.problem_id === state.selectedId && p.problem_type === 'missed_road';
    });
  }

  function drawDivergenceLines(rows) {
    if (state.divLines) {
      map.removeLayer(state.divLines);
      state.divLines = null;
    }
    state.divLegend = false;
    state.offRouteLegend = false;
    state.missedLegend = false;
    state.detourLegend = false;
    state.detourBounds = null;
    var group = L.layerGroup();
    var n = 0;
    divergenceRowsForLines(rows).forEach(function (p) {
      if (!p.metadata || !hasGeo(p)) return;
      var lat = Number(p.lat);
      var lon = Number(p.lon);
      var matched = clipAroundPin(p.metadata.matched_line, lat, lon);
      var drive = clipAroundPin(p.metadata.gps_line, lat, lon);
      if (matched) {
        L.polyline(matched, { color: '#0f71fa', weight: 5, opacity: 0.9 }).addTo(group);
        n += 1;
      }
      if (drive) {
        L.polyline(drive, { color: '#dc2b28', weight: 5, opacity: 0.95 }).addTo(group);
        n += 1;
      }
    });
    offRouteRows(rows).forEach(function (p) {
      if (!p.metadata || !hasGeo(p)) return;
      var lat = Number(p.lat);
      var lon = Number(p.lon);
      var route = clipAroundPin(p.metadata.route_line, lat, lon, 150);
      var drive = clipAroundPin(p.metadata.gps_line, lat, lon, 150);
      if (route) {
        L.polyline(route, { color: '#0f71fa', weight: 5, opacity: 0.9 }).addTo(group);
        n += 1;
        state.offRouteLegend = true;
      }
      if (drive) {
        L.polyline(drive, { color: '#dc2b28', weight: 5, opacity: 0.95 }).addTo(group);
        n += 1;
        state.offRouteLegend = true;
      }
    });
    missedRoadRows(rows).forEach(function (p) {
      if (!p.metadata || !hasGeo(p)) return;
      var lat = Number(p.lat);
      var lon = Number(p.lon);
      var road = clipAroundPin(p.metadata.road_line, lat, lon);
      var drive = clipAroundPin(p.metadata.gps_line, lat, lon);
      if (road) {
        L.polyline(road, { color: '#7a8589', weight: 5, opacity: 0.9 }).addTo(group);
        n += 1;
        state.missedLegend = true;
      }
      if (drive) {
        L.polyline(drive, { color: '#dc2b28', weight: 5, opacity: 0.95 }).addTo(group);
        n += 1;
        state.missedLegend = true;
      }
    });
    rows.forEach(function (p) {
      if (p.problem_id !== state.selectedId || p.problem_type !== 'node_detour' || !p.metadata) return;
      var route = latLngsFromLine(p.metadata.route_line);
      var drive = latLngsFromLine(p.metadata.gps_line);
      var fit = [];
      if (route) {
        L.polyline(route, { color: '#0f71fa', weight: 5, opacity: 0.9 }).addTo(group);
        n += 1;
        fit = fit.concat(route);
      }
      if (drive) {
        L.polyline(drive, { color: '#dc2b28', weight: 5, opacity: 0.95 }).addTo(group);
        n += 1;
        fit = fit.concat(drive);
      }
      if (fit.length) {
        state.detourLegend = true;
        state.detourBounds = fit;
      }
    });
    if (!n) return;
    state.divLegend = true;
    state.divLines = group;
    group.addTo(map);
  }

  function drawMap(rows) {
    ensureMap();
    if (state.cluster) map.removeLayer(state.cluster);
    state.cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 48, spiderfyOnMaxZoom: true });
    state.markersById = {};
    var bounds = [];
    rows.forEach(function (p) {
      if (!hasGeo(p)) return;
      var m = L.marker([Number(p.lat), Number(p.lon)], {
        icon: pinIcon(p, p.problem_id === state.selectedId),
        problemId: p.problem_id
      });
      m.bindPopup(popupHtml(p));
      m.on('click', function () { selectFinding(p.problem_id, false); });
      state.cluster.addLayer(m);
      state.markersById[p.problem_id] = m;
      bounds.push([Number(p.lat), Number(p.lon)]);
    });
    state.cluster.on('clusterclick', function (ev) {
      var kids = ev.layer.getAllChildMarkers();
      var tally = {};
      var firstId = {};
      kids.forEach(function (child) {
        var id = child.options.problemId;
        var key = placeKeyById[id];
        if (!key) return;
        tally[key] = (tally[key] || 0) + 1;
        if (!firstId[key]) firstId[key] = id;
      });
      var keys = Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; });
      if (!keys.length) return;
      selectFinding(firstId[keys[0]], false);
      state.litPlaces = {};
      keys.forEach(function (k) {
        state.litPlaces[k] = true;
        state.expandedTraces[k] = true;
      });
      renderList(filtered());
      scrollFindingIntoView(firstId[keys[0]]);
      markActiveRow(firstId[keys[0]]);
      drawDivergenceLines(filtered());
    });
    map.addLayer(state.cluster);
    drawDivergenceLines(rows);
    drawOverlay();
    if (bounds.length && state.shouldFit) {
      map.fitBounds(bounds, { padding: [28, 28], maxZoom: 12 });
      state.shouldFit = false;
    }
    var used = {};
    var legend = Object.keys(Q_COLORS).filter(function (q) {
      return rows.some(function (p) { return p.q_code === q; });
    }).map(function (q) {
      used[q] = true;
      return '<span class="mr12"><span class="legend-swatch" style="background:' + qColor(q) + '"></span>' + q + '</span>';
    }).join('');
    var divNote = state.divLegend
      ? '<span class="mr12"><span class="legend-swatch" style="background:#dc2b28"></span>GPS drive</span><span class="mr12"><span class="legend-swatch" style="background:#0f71fa"></span>map-matched</span>'
      : '';
    var missedNote = state.missedLegend
      ? '<span class="mr12"><span class="legend-swatch" style="background:#dc2b28"></span>drive</span><span class="mr12"><span class="legend-swatch" style="background:#7a8589"></span>nearest OSM road</span>'
      : '';
    var offRouteNote = state.offRouteLegend
      ? '<span class="mr12"><span class="legend-swatch" style="background:#0f71fa"></span>proposed route</span><span class="mr12"><span class="legend-swatch" style="background:#dc2b28"></span>actual drive</span>'
      : '';
    var detourNote = state.detourLegend
      ? '<span class="mr12"><span class="legend-swatch" style="background:#0f71fa"></span>planned route</span><span class="mr12"><span class="legend-swatch" style="background:#dc2b28"></span>actual drive</span>'
      : '';
    $('map-legend').innerHTML = (legend || 'No points in the current filter. Turn off “Coordinates only” or pick another tab.') + divNote + offRouteNote + missedNote + detourNote;
  }

  function listFingerprint() {
    var f = currentFilters();
    return [f.qCode, f.category, f.type, f.sort, f.search, f.severity, f.label, state.traceFile].join('|');
  }

  function saveLastPos(n, id, total) {
    try {
      localStorage.setItem(LAST_POS_KEY, JSON.stringify({
        n: n, id: id, total: total, fp: listFingerprint()
      }));
    } catch (e) {}
  }

  function loadLastPos() {
    try { return JSON.parse(localStorage.getItem(LAST_POS_KEY) || 'null'); }
    catch (e) { return null; }
  }

  function indexInList(id, rows) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].problem_id === id) return i + 1;
    }
    return null;
  }

  function directionsDebugUrl(p) {
    if (!hasGeo(p)) return '';
    var lat = Number(p.lat);
    var lon = Number(p.lon);
    var speed = p.problem_type === 'speed_limit_suspect' || p.problem_type === 'speed_limit_missing';
    var route = lon.toFixed(6) + ',' + lat.toFixed(6);
    var query = 'steps=true&overview=full&geometries=geojson&roundabout_exits=true&voice_units=imperial&language=en&voice_instructions=true&banner_instructions=true&alternatives=true&annotations=duration,speed,current_speed,historical_speed,congestion,maxspeed';
    var debug = speed ? '&debug_layer=valhalla-speed-limits' : '';
    return 'https://console.mapbox.com/directions-debug/#route=' + route +
      '&map=' + lon.toFixed(5) + ',' + lat.toFixed(5) + ',17z' +
      '&server=https://api.mapbox.com&profile=mapbox/driving-traffic&annotation=none&queryparams=' +
      encodeURIComponent(query) + debug;
  }

  function tagControls(p) {
    var rec = reviewOf(p.problem_id);
    if (rec && rec.tag) {
      return '<div class="tag-actions"><span class="tag-pill tag-' + escapeHtml(rec.tag) + '">' + escapeHtml(tagLabel(rec.tag)) + '</span>' +
        '<span class="tag-by txt-xs color-gray">by ' + escapeHtml(rec.reviewer || 'reviewer') + '</span>' +
        '<button type="button" class="tag-undo" data-id="' + escapeHtml(p.problem_id) + '">Undo</button></div>';
    }
    var html = '<div class="tag-actions">';
    TAGS.forEach(function (t) {
      html += '<button type="button" class="tag-btn" data-tag="' + t.id + '" data-id="' + escapeHtml(p.problem_id) + '">' +
        escapeHtml(t.short) + '</button>';
    });
    return html + '</div>';
  }

  function renderList(rows) {
    var cap = LIST_CAP;
    if (state.selectedId) {
      var selAt = indexInList(state.selectedId, rows);
      if (selAt) cap = Math.max(cap, selAt);
    }
    var extra = rows.length > cap ? rows.length - cap : 0;
    var show = rows.slice(0, cap);
    var last = loadLastPos();
    var lastBit = '';
    if (last && last.fp === listFingerprint() && last.n) {
      lastBit = ' · last #' + last.n;
    }
    var tagged = 0;
    for (var mi = 0; mi < rows.length; mi++) {
      if (reviewOf(rows[mi].problem_id)) tagged++;
    }
    $('list-count').textContent = (extra ? ('showing ' + show.length + ' of ' + rows.length) : (rows.length + ' shown')) +
      ' · ' + tagged + ' tagged · ' + rows.length + ' total' +
      lastBit +
      (state.traceFile ? ' · this trace' : '');
    if (!show.length) {
      $('result-list').innerHTML = '<div class="txt-s color-gray">No findings match these filters.</div>';
      return;
    }
    var html = '';
    show.forEach(function (p, i) {
      var rec = reviewOf(p.problem_id);
      var active = p.problem_id === state.selectedId ? ' is-active' : '';
      var where = hasGeo(p) ? (Number(p.lat).toFixed(5) + ', ' + Number(p.lon).toFixed(5)) : 'no coordinates';
      html += '<div class="result-row flex flex--center-cross px12 py12 round mb6 bg-gray-faint' + active +
        (rec ? ' is-tagged tag-' + escapeHtml(rec.tag) : '') +
        '" data-id="' + escapeHtml(p.problem_id) + '" style="width:100%;text-align:left;cursor:pointer;">' +
        '<span class="row-num txt-s txt-mono txt-bold mr12">#' + (i + 1) + '</span>' +
        '<span class="pin-dot mr12" style="background:' + qColor(p.q_code) + '"></span>' +
        '<span class="flex-child-grow">' +
        '<div class="txt-s txt-bold color-gray-dark">' + escapeHtml(p.problem_type || p.q_code) +
        ' · ' + escapeHtml(p.severity || '') +
        (repeatLabel(p) ? ' <button type="button" class="repeat-mark" data-also="' + escapeHtml(p.problem_id) + '" title="Show the other trace file names">' + escapeHtml(repeatLabel(p)) + '</button>' : '') +
        alsoFilesHtml(p) +
        tagControls(p) + '</div>' +
        '<div class="txt-s color-gray truncate">' + escapeHtml(p.summary || '') + '</div>' +
        '<div class="txt-xs color-gray">' + escapeHtml(where) + ' · ' + escapeHtml(shortTraceLabel(traceKey(p))) +
        ' · ' + escapeHtml(p.timestamp_utc || 'no time') +
        (function () {
          var hint = metricHint(p, $('filter-sort').value);
          return hint ? ' · ' + escapeHtml(hint) : '';
        }()) + '</div>' +
        '</span>' +
        (hasGeo(p)
          ? '<a class="dd-link btn btn--s btn--stroke btn-pill px12" href="' + escapeHtml(directionsDebugUrl(p)) + '" target="_blank" rel="noopener" title="Open this place in Directions Debug">DD</a>'
          : '') +
        '</div>';
    });
    if (extra) html += '<div class="txt-s color-gray mt6">Tighten filters to see the rest.</div>';
    var list = $('result-list');
    var top = list.scrollTop;
    list.innerHTML = html;
    list.scrollTop = top;
  }

  function formatFieldValue(v) {
    if (v == null || v === '') return '—';
    if (typeof v === 'object') {
      try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
    }
    return String(v);
  }

  function renderTraceName(p) {
    var bar = $('trace-name-bar');
    if (!bar) return;
    var file = (p && traceKey(p)) || state.traceFile || '';
    if (!file) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    bar.hidden = false;
    bar.innerHTML =
      '<div class="txt-s color-gray mb6">Trace</div>' +
      '<div class="trace-filename txt-s">' + escapeHtml(file) + '</div>' +
      '<button type="button" class="btn btn--s btn--stroke mt6" id="open-trace" data-trace="' + escapeHtml(file) +
      '" title="Show all findings from this trace">open trace</button>';
  }

  function renderDetail(p) {
    renderTraceName(p);
    if (!p) {
      $('detail-card').innerHTML = '<div class="txt-s color-gray">Select a finding on the map or in the list.</div>';
      return;
    }
    var vis = filtered();
    var n = indexInList(p.problem_id, vis);
    var total = vis.length;
    var rec = reviewOf(p.problem_id);
    var meta = p.metadata && typeof p.metadata === 'object' ? p.metadata : {};
    var metaRows = Object.keys(meta).map(function (k) {
      return '<div class="txt-s mb6"><span class="color-gray">' + escapeHtml(k) + ': </span>' + escapeHtml(formatFieldValue(meta[k])) + '</div>';
    }).join('');
    var metadataJson = '';
    try { metadataJson = JSON.stringify(meta, null, 2); } catch (e) { metadataJson = String(meta); }
    $('detail-card').innerHTML =
      '<div class="txt-s txt-bold txt-uppercase color-gray txt-spacing1 mb12">Finding' +
      (n ? ' · #' + n + ' of ' + (total || '—') : '') +
      (repeatLabel(p) ? ' · ' + escapeHtml(repeatLabel(p)) : '') + '</div>' +
      alsoFilesHtml(p) +
      '<div class="txt-m txt-bold color-gray-dark mb6">' + escapeHtml(p.summary || p.problem_type) + '</div>' +
      '<div class="txt-s color-gray mb12">' + escapeHtml(p.q_code) + ' · ' + escapeHtml(p.category) + ' · ' +
      escapeHtml(p.problem_type) + ' · ' + escapeHtml(p.severity) + '</div>' +
      '<div class="txt-s txt-mono mb12">' + escapeHtml(p.problem_id) + '</div>' +
      '<div class="txt-s mb6">Time: ' + escapeHtml(p.timestamp_utc || '—') + '</div>' +
      '<div class="txt-s mb6">Coords: ' + (hasGeo(p) ? Number(p.lat).toFixed(5) + ', ' + Number(p.lon).toFixed(5) : 'none') +
      (meta.geo_source ? ' <span class="color-gray">(' + escapeHtml(meta.geo_source) + ')</span>' : '') +
      (hasGeo(p) ? ' <a class="ml6" href="' + escapeHtml(directionsDebugUrl(p)) + '" target="_blank" rel="noopener">Open in DD</a>' : '') + '</div>' +
      '<div class="txt-s mb6">VIN: ' + escapeHtml(p.vehicle || '—') + '</div>' +
      '<div class="txt-s mb6">User: ' + escapeHtml(p.user_id || '—') + '</div>' +
      '<div class="txt-s mb6">Project / platform: ' + escapeHtml(p.project || '—') + ' / ' + escapeHtml(p.platform || '—') + '</div>' +
      '<div class="detail-scroll mb18">' +
      '<div class="txt-s mb12"><span class="color-gray">summary: </span>' + escapeHtml(p.summary || '—') + '</div>' +
      (metaRows || '<div class="txt-s color-gray mb12">No extra metadata.</div>') +
      '<div class="txt-s color-gray mb6">metadata_json:</div>' +
      '<pre class="txt-xs txt-mono meta-json">' + escapeHtml(metadataJson) + '</pre>' +
      '</div>' +
      '<div class="txt-s txt-bold txt-uppercase color-gray txt-spacing1 mb12">Tag</div>' +
      (rec && rec.tag
        ? '<div class="txt-s color-gray mb6">Undo clears this tag. Then another tag can be set.</div>' + tagControls(p)
        : '<div class="txt-s color-gray mb6">Set one tag. Undo clears it if the decision changes.</div>' + tagControls(p));
  }

  function findTraceByPbf(raw) {
    var name = String(raw || '').trim().split(/[/\\]/).pop();
    if (!name) return { error: 'Paste a trace file name.' };
    var files = [];
    var seen = {};
    for (var i = 0; i < state.problems.length; i++) {
      var file = state.problems[i].trace_file || '';
      if (!file || seen[file]) continue;
      seen[file] = true;
      files.push(file);
    }
    function compact(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
    function one(list) {
      if (list.length === 1) return { key: list[0] };
      if (list.length > 1) return { error: 'Several traces match. Paste a longer name.' };
      return null;
    }
    var wanted = compact(name);
    var exact = one(files.filter(function (file) {
      var folded = compact(file);
      return file === name || folded === wanted || folded.slice(-wanted.length) === wanted;
    }));
    if (exact) return exact;
    var stamp = name.match(/^\d{4}-\d{2}-\d{2}T[\d_.:]+Z/);
    if (stamp) {
      var hits = files.filter(function (file) { return file.indexOf(stamp[0]) === 0; });
      if (hits.length === 1) return { key: hits[0] };
      if (hits.length > 1) return { error: 'Several traces match. Paste a longer name.' };
      return { error: 'This trace is not in the current list. The board has trips from 17 to 23 Sep 2026.' };
    }
    var loose = one(files.filter(function (file) {
      return compact(file).indexOf(wanted) !== -1 || wanted.indexOf(compact(file)) !== -1;
    }));
    if (loose) return loose;
    if (!/pbf\.gz$/i.test(wanted)) return { error: 'The name has to end with .pbf.gz.' };
    return { error: 'This trace is not in the current list. The board has trips from 17 to 23 Sep 2026.' };
  }

  function runTraceFinder() {
    var input = $('trace-finder');
    var status = $('trace-finder-status');
    var found = findTraceByPbf(input ? input.value : '');
    if (found.error) {
      if (status) status.textContent = found.error;
      return;
    }
    if (status) status.textContent = 'Found. Open trace shows every finding from this file.';
    openTrace(found.key);
    var bar = $('trace-name-bar');
    if (bar) bar.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openTrace(key) {
    if (!key) return;
    state.traceFile = key;
    state.shouldFit = true;
    refresh();
    var panel = $('trace-panel');
    if (panel && !panel.hidden) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function clearTrace() {
    state.traceFile = '';
    state.shouldFit = true;
    refresh();
  }

  function renderTracePanel() {
    var el = $('trace-panel');
    if (!el) return;
    if (!state.traceFile) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    var rows = findingsForTrace(state.traceFile);
    if (!rows.length) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    var sample = rows[0];
    var c = counts(rows);
    var qKeys = Object.keys(c.byQ).sort();
    var qLine = qKeys.map(function (q) {
      return '<span class="mr12"><span class="legend-swatch" style="background:' + qColor(q) + '"></span>' +
        escapeHtml(q) + ' · ' + c.byQ[q] + '</span>';
    }).join('');
    var groups = {};
    rows.forEach(function (p) {
      var q = p.q_code || 'other';
      if (!groups[q]) groups[q] = [];
      groups[q].push(p);
    });
    var sortMode = $('filter-sort').value;
    var groupHtml = Object.keys(groups).sort().map(function (q) {
      var bucket = groups[q].slice();
      if (sortMode && sortMode !== 'severity' && sortMode !== 'time' && sortMode !== 'q') {
        bucket.sort(function (a, b) { return compareMetric(a, b, sortMode); });
      }
      var items = bucket.map(function (p) {
        var rec = reviewOf(p.problem_id);
        var active = p.problem_id === state.selectedId ? ' is-active' : '';
        return '<button type="button" class="result-row flex flex--center-cross px12 py12 round mb6 bg-gray-faint' + active +
          '" data-id="' + escapeHtml(p.problem_id) + '" style="width:100%;text-align:left;border:0;cursor:pointer;">' +
          '<span class="pin-dot mr12" style="background:' + qColor(p.q_code) + '"></span>' +
          '<span class="flex-child-grow">' +
          '<div class="txt-s txt-bold color-gray-dark">' + escapeHtml(p.problem_type || p.q_code) +
          ' · ' + escapeHtml(p.severity || '') +
          (rec ? ' · ' + escapeHtml(tagLabel(rec.tag)) : '') + '</div>' +
          '<div class="txt-s color-gray">' + escapeHtml(p.summary || '') + '</div>' +
          '<div class="txt-xs color-gray">' + escapeHtml(p.timestamp_utc || 'no time') +
          (hasGeo(p) ? ' · ' + Number(p.lat).toFixed(5) + ', ' + Number(p.lon).toFixed(5) : '') + '</div>' +
          '</span></button>';
      }).join('');
      return '<div class="mb18"><div class="txt-s txt-bold mb8">' +
        '<span class="legend-swatch" style="background:' + qColor(q) + '"></span>' +
        escapeHtml(q) + ' · ' + groups[q].length + '</div>' + items + '</div>';
    }).join('');
    var scroller = el.querySelector('.trace-findings');
    var top = scroller ? scroller.scrollTop : 0;
    el.hidden = false;
    el.innerHTML =
      '<div class="card px18 py18">' +
      '<div class="flex flex--space-between-main flex--center-cross mb12">' +
      '<div class="txt-s txt-bold txt-uppercase color-gray txt-spacing1">Trace</div>' +
      '<button type="button" class="btn btn--s btn--stroke btn-pill px12" id="clear-trace">Show all traces</button>' +
      '</div>' +
      '<div class="txt-s txt-mono trace-filename mb12">' + escapeHtml(sample.trace_file || sample.report_file || state.traceFile) + '</div>' +
      '<div class="txt-s mb6">VIN: ' + escapeHtml(sample.vehicle || '—') +
      ' · User: ' + escapeHtml(sample.user_id || '—') + '</div>' +
      '<div class="txt-s mb6">Project / platform: ' + escapeHtml(sample.project || '—') +
      ' / ' + escapeHtml(sample.platform || '—') +
      (sample.nav_native ? ' · Nav Native ' + escapeHtml(sample.nav_native) : '') + '</div>' +
      '<div class="txt-s mb12">' + c.n + ' findings' +
      ' · high ' + (c.bySev.high || 0) +
      ' · medium ' + (c.bySev.medium || 0) +
      ' · low ' + (c.bySev.low || 0) + '</div>' +
      '<div class="txt-s mb18">' + qLine + '</div>' +
      '<div class="trace-findings">' + groupHtml + '</div>' +
      '</div>';
    var next = el.querySelector('.trace-findings');
    if (next) next.scrollTop = top;
  }

  function scrollFindingIntoView(id) {
    if (!id) return;
    var rows = document.querySelectorAll('#result-list .result-row[data-id]');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-id') === id) {
        rows[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
    }
  }

  function markActiveRow(id) {
    var rows = document.querySelectorAll('.result-row[data-id]');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.getAttribute('data-id') === id) row.classList.add('is-active');
      else row.classList.remove('is-active');
    }
  }

  function paintReviews() {
    var vis = filtered();
    renderKpis(state.problems, vis);
    renderList(vis);
    renderReviewStats(vis);
    renderTracePanel();
    var selected = state.problems.filter(function (p) { return p.problem_id === state.selectedId; })[0];
    if (selected) renderDetail(selected);
  }

  function renderReviewStats(rows) {
    var box = $('review-stats');
    var status = $('review-status');
    if (!box) return;
    var tags = { true_detection: 0, false_positive: 0, na: 0 };
    rows.forEach(function (p) {
      var rec = reviewOf(p.problem_id);
      if (rec && tags[rec.tag] != null) tags[rec.tag] += 1;
    });
    var untagged = rows.length - tags.true_detection - tags.false_positive - tags.na;
    box.innerHTML =
      statCell('True Detection', tags.true_detection) +
      statCell('False positive detection', tags.false_positive) +
      statCell('N/A', tags.na) +
      statCell('Not tagged', untagged);
    if (!status) return;
    if (state.reviewError) status.textContent = state.reviewError;
    else if (state.reviewLive) {
      status.textContent = 'Shared with everyone on this server. ' + rows.length + ' findings in this filter. Undo clears a tag so it can be changed.';
    } else status.textContent = 'Shared tags are off. Start serve_board.py so every reviewer sees the same tags.';
  }

  function statCell(label, n) {
    return '<div class="review-stat"><div class="txt-xs color-gray mb6">' + escapeHtml(label) +
      '</div><div class="num">' + n.toLocaleString() + '</div></div>';
  }

  function assignTag(id, tag) {
    if (!id || !tagMeta(tag)) return;
    if (reviewOf(id)) return;
    var name = reviewerName();
    if (!name) {
      state.reviewError = 'Enter your name, then set the tag.';
      var input = $('reviewer-name');
      if (input) input.focus();
      renderReviewStats(filtered());
      return;
    }
    try { localStorage.setItem(REVIEWER_KEY, name); } catch (e) {}
    if (!state.reviewLive) {
      state.reviewError = 'Shared tags are off. Start serve_board.py and reopen this page.';
      renderReviewStats(filtered());
      return;
    }
    fetch('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problem_id: id, tag: tag, reviewer: name })
    }).then(function (res) {
      return res.json().then(function (body) { return { status: res.status, body: body }; });
    }).then(function (result) {
      var review = result.body && result.body.review;
      if (result.status === 200 && review) {
        state.reviews[id] = review;
        state.reviewError = '';
      } else if (review) {
        state.reviews[id] = review;
        state.reviewError = 'Already tagged by ' + (review.reviewer || 'another reviewer') + '.';
      } else {
        state.reviewError = 'Could not save the tag.';
      }
      paintReviews();
    }).catch(function () {
      state.reviewError = 'Could not save the tag. Check that serve_board.py is running.';
      renderReviewStats(filtered());
    });
  }

  function clearTag(id) {
    if (!id || !reviewOf(id)) return;
    if (!state.reviewLive) {
      state.reviewError = 'Shared tags are off. Start serve_board.py and reopen this page.';
      renderReviewStats(filtered());
      return;
    }
    fetch('/api/reviews', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problem_id: id })
    }).then(function (res) {
      return res.json().then(function (body) { return { status: res.status, body: body }; });
    }).then(function (result) {
      if (result.status === 200) {
        delete state.reviews[id];
        state.reviewError = '';
      } else {
        state.reviewError = 'Could not clear the tag.';
      }
      paintReviews();
    }).catch(function () {
      state.reviewError = 'Could not clear the tag. Check that serve_board.py is running.';
      renderReviewStats(filtered());
    });
  }

  function selectFinding(id, fly) {
    state.selectedId = id;
    var p = state.problems.filter(function (x) { return x.problem_id === id; })[0];
    var place = null;
    if (p) {
      filtered();
      place = placeKeyById[id];
      state.litPlaces = {};
      if (place) {
        state.litPlaces[place] = true;
        state.expandedTraces[place] = true;
      }
      renderList(filtered());
      scrollFindingIntoView(id);
    }
    markActiveRow(id);
    renderDetail(p);
    if (p) {
      var visNow = filtered();
      var blockN = indexInList(id, visNow);
      var blockTotal = visNow.length;
      if (blockN) {
        saveLastPos(blockN, id, blockTotal);
        var countEl = $('list-count');
        if (countEl) {
          countEl.textContent = countEl.textContent.replace(/ · last #\d+/, '') + ' · last #' + blockN;
        }
      }
    }
    drawDivergenceLines(filtered());
    if (p && p.problem_type === 'node_detour' && state.detourBounds) {
      map.fitBounds(state.detourBounds, { padding: [36, 36], maxZoom: 15 });
    } else if (p && hasGeo(p) && fly !== false) {
      var m = state.markersById[id];
      if (m && state.cluster) {
        state.cluster.zoomToShowLayer(m, function () {
          m.setIcon(pinIcon(p, true));
          m.openPopup();
          map.setView(m.getLatLng(), Math.max(map.getZoom(), 14));
        });
      } else {
        map.setView([Number(p.lat), Number(p.lon)], 14);
      }
    }
  }

  function refresh() {
    if ($('list-sort') && $('filter-sort')) $('list-sort').value = $('filter-sort').value;
    var vis = filtered();
    renderKpis(state.problems, vis);
    renderQChips(state.problems);
    renderTabs(state.problems);
    fillSelect($('filter-type'), unique(state.category ? state.problems.filter(function (p) { return p.category === state.category; }) : state.problems, 'problem_type'), 'All types');
    drawMap(vis);
    renderList(vis);
    renderReviewStats(vis);
    renderTracePanel();
    var selected = vis.filter(function (p) { return p.problem_id === state.selectedId; })[0];
    if (!selected) {
      state.selectedId = null;
      renderDetail(null);
    } else renderDetail(selected);
  }

  function bootUi() {
    fillSelect($('filter-project'), unique(state.problems, 'project'), 'All');
    fillSelect($('filter-platform'), unique(state.problems, 'platform'), 'All');
    $('data-status').textContent = state.problems.length.toLocaleString() + ' findings · ' + state.sourceName;
    state.shouldFit = true;
    refresh();
  }

  function exportTriage() {
    var lines = [['problem_id', 'tag', 'reviewer', 'at', 'q_code', 'problem_type', 'severity', 'lat', 'lon', 'summary'].join(',')];
    Object.keys(state.reviews).forEach(function (id) {
      var t = state.reviews[id];
      var p = state.problems.filter(function (x) { return x.problem_id === id; })[0] || {};
      function csv(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
      lines.push([id, tagLabel(t.tag), t.reviewer, t.at, p.q_code, p.problem_type, p.severity, p.lat, p.lon, p.summary].map(csv).join(','));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'review-tags.csv';
    a.click();
  }

  function bind() {
    $('btn-load').addEventListener('click', function () { $('file-input').click(); });
    $('btn-export').addEventListener('click', exportTriage);
    $('file-input').addEventListener('change', function (ev) {
      var files = Array.prototype.slice.call(ev.target.files || []);
      files.forEach(function (file) {
        var reader = new FileReader();
        reader.onload = function () {
          try { ingest(reader.result, file.name); }
          catch (err) { alert('Could not read ' + file.name + ': ' + err.message); }
        };
        reader.readAsText(file);
      });
      ev.target.value = '';
    });
    ['search', 'filter-severity', 'filter-label',
      'filter-project', 'filter-platform', 'filter-vehicle', 'filter-user', 'filter-from', 'filter-to', 'filter-geo'
    ].forEach(function (id) {
      $(id).addEventListener('input', refresh);
      $(id).addEventListener('change', refresh);
    });
    $('filter-type').addEventListener('change', function () {
      applySuggestedSort();
      refresh();
    });
    function onSortChange(ev) {
      setSort(ev.target.value);
      refresh();
    }
    $('filter-sort').addEventListener('change', onSortChange);
    $('list-sort').addEventListener('change', onSortChange);
    $('trace-finder-go').addEventListener('click', runTraceFinder);
    $('trace-finder').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        runTraceFinder();
      }
    });
    $('q-chips').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-q]');
      if (!btn) return;
      state.qCode = btn.getAttribute('data-q');
      state.shouldFit = true;
      applySuggestedSort();
      refresh();
    });
    $('category-tabs').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-cat]');
      if (!btn) return;
      state.category = btn.getAttribute('data-cat');
      $('filter-type').value = '';
      state.shouldFit = true;
      applySuggestedSort();
      refresh();
    });
    $('result-list').addEventListener('click', function (e) {
      var undo = e.target.closest('.tag-undo');
      if (undo) {
        e.stopPropagation();
        clearTag(undo.getAttribute('data-id'));
        return;
      }
      if (e.target.closest('.tag-btn')) {
        e.stopPropagation();
        var btn = e.target.closest('.tag-btn');
        assignTag(btn.getAttribute('data-id'), btn.getAttribute('data-tag'));
        return;
      }
      if (e.target.closest('.dd-link') || e.target.closest('.also-files')) {
        e.stopPropagation();
        return;
      }
      var badge = e.target.closest('.repeat-mark');
      if (badge) {
        var alsoId = badge.getAttribute('data-also');
        state.showAlsoId = state.showAlsoId === alsoId ? '' : alsoId;
        if (state.showAlsoId) selectFinding(alsoId, true);
        else refresh();
        return;
      }
      var row = e.target.closest('[data-id]');
      if (!row) return;
      selectFinding(row.getAttribute('data-id'), true);
    });
    $('detail-card').addEventListener('click', function (e) {
      var undo = e.target.closest('.tag-undo');
      if (undo) {
        clearTag(undo.getAttribute('data-id'));
        return;
      }
      var btn = e.target.closest('.tag-btn');
      if (!btn) return;
      assignTag(btn.getAttribute('data-id'), btn.getAttribute('data-tag'));
    });
    $('trace-name-bar').addEventListener('click', function (e) {
      var open = e.target.closest('#open-trace');
      if (open) openTrace(open.getAttribute('data-trace'));
    });
    $('trace-panel').addEventListener('click', function (e) {
      if (e.target.closest('#clear-trace')) {
        clearTrace();
        return;
      }
      var row = e.target.closest('[data-id]');
      if (row) selectFinding(row.getAttribute('data-id'), true);
    });
  }

  function syncReviews(forcePaint) {
    return fetch('/api/reviews', { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('no api');
      return res.json();
    }).then(function (data) {
      var next = (data && data.reviews) || {};
      var changed = JSON.stringify(next) !== JSON.stringify(state.reviews);
      state.reviews = next;
      state.reviewLive = true;
      if (!changed && !forcePaint) return;
      state.reviewError = '';
      if (state.problems.length) paintReviews();
    }).catch(function () {
      var wasLive = state.reviewLive;
      state.reviewLive = false;
      if (wasLive || forcePaint) {
        state.reviewError = '';
        if (state.problems.length) renderReviewStats(filtered());
      }
    });
  }

  function initReviewer() {
    var el = $('reviewer-name');
    if (!el) return;
    try { el.value = localStorage.getItem(REVIEWER_KEY) || ''; } catch (e) {}
    el.addEventListener('change', function () {
      try { localStorage.setItem(REVIEWER_KEY, el.value.trim()); } catch (e) {}
    });
  }

  bind();
  initReviewer();
  if (window.TRACE_PROBLEMS) {
    ingest(window.TRACE_PROBLEMS, 'bundled snapshot');
  } else {
    $('data-status').textContent = 'No bundled data. Use Load file.';
    ensureMap();
  }
  syncReviews(true);
  setInterval(function () { syncReviews(false); }, 4000);
})();
