const byId = (id) => document.getElementById(id);
let activeScanId;
let pollTimer;
let loading = false;
let submitting = false;
let touchedRepository = false;

function showError(message, canRetry = false) {
  byId('error-message').textContent = message;
  byId('error').hidden = false;
  byId('retry').hidden = !canRetry;
}

function clearError() {
  byId('error').hidden = true;
  byId('retry').hidden = true;
}

async function request(path, options) {
  let response;
  try {
    response = await fetch(path, { ...options, signal: AbortSignal.timeout(10000) });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError'
      ? 'Request timed out. Retry.'
      : 'Cannot reach the server. Retry.');
  }
  let body;
  try { body = await response.json(); } catch {
    throw new Error('Unexpected server response. Retry.');
  }
  if (!response.ok) {
    const message = response.status >= 500
      ? 'Server error. Retry.'
      : body.error || 'Request failed. Retry.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

function repositoryDetails(value) {
  try {
    const url = new URL(value);
    const path = url.pathname.match(/^\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+)\/?$/);
    if (!/^https:\/\/github\.com\//i.test(value) || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !path) return;
    const repo = path[2].replace(/\.git$/, '');
    if (repo && repo !== '.' && repo !== '..') return `${path[1]}/${repo}`;
  } catch { /* Invalid input is explained beside the field. */ }
}

function validateRepository(showInvalid = false) {
  const input = byId('repository-url');
  const value = input.value.trim();
  const repo = repositoryDetails(value);
  const invalid = !repo && showInvalid;
  input.setAttribute('aria-invalid', String(invalid));
  byId('repository-feedback').textContent = value ? 'Use https://github.com/owner/repo.' : 'Enter a repository URL.';
  byId('repository-feedback').hidden = !invalid;
  return Boolean(repo);
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderReport(report) {
  const { summary, findings } = report.content;
  byId('analysis').textContent = report.content.analysis || '';
  const source = report.content.repository;
  if (source) {
    byId('source-summary').textContent = `${source.textFileCount} text files · ${source.defaultBranch} · ${source.commitSha.slice(0, 7)}${source.skippedFileCount ? ` · ${source.skippedFileCount} skipped` : ''}`;
    byId('source-summary').hidden = false;
  }
  const stats = [['total', summary.total], ...Object.entries(summary.bySeverity)];
  byId('summary').replaceChildren(...stats.map(([severity, count]) => {
    const item = element('div', '', `stat ${severity}`);
    const label = severity === 'total' ? 'Total findings' : severity.charAt(0).toUpperCase() + severity.slice(1);
    item.append(element('span', label), element('strong', String(count)));
    return item;
  }));
  function renderFinding(finding, showRecommendation = true) {
    const item = element('article', '', 'finding');
    const heading = element('div', '', 'finding-heading');
    heading.append(element('span', finding.severity, `severity ${finding.severity}`), element('h3', finding.title));
    const location = element('div', '', 'finding-location');
    location.append(element('code', `${finding.filePath}:${finding.line}`));
    item.append(heading, element('p', finding.description), location);
    if (showRecommendation && finding.recommendation) item.append(element('p', `Recommended action: ${finding.recommendation}`));
    return item;
  }
  const groups = report.content.actionGroups;
  if (groups) {
    const byFindingId = new Map(findings.map((finding) => [finding.id, finding]));
    byId('findings').replaceChildren(...groups.map((group) => {
      if (group.findingIds.length === 1 && byFindingId.has(group.findingIds[0])) {
        return renderFinding(byFindingId.get(group.findingIds[0]));
      }
      const item = element('article', '', 'finding');
      const heading = element('div', '', 'finding-heading');
      heading.append(element('span', group.severity, `severity ${group.severity}`), element('h3', group.title));
      item.append(heading, element('p', `Recommended action: ${group.recommendation}`));
      const details = document.createElement('details');
      details.append(element('summary', `${group.findingIds.length} finding${group.findingIds.length === 1 ? '' : 's'} · View details`));
      for (const id of group.findingIds) {
        const finding = byFindingId.get(id);
        if (finding) details.append(renderFinding(finding, false));
      }
      item.append(details);
      return item;
    }));
  } else {
    byId('findings').replaceChildren(...findings.map((finding) => renderFinding(finding)));
  }
  if (!findings.length) {
    byId('findings').append(element('p', 'No findings.', 'empty-state'));
  }
  byId('scan-heading').textContent = 'Completed';
  byId('progress-panel').hidden = true;
  byId('results').hidden = false;
}

async function poll() {
  if (loading) return;
  loading = true;
  clearTimeout(pollTimer);
  clearError();
  byId('retry').disabled = true;
  byId('scan').setAttribute('aria-busy', 'true');
  let loadingReport = false;
  try {
    const scan = await request(`/scans/${activeScanId}`);
    byId('repository').textContent = scan.repositoryUrl;
    byId('stage').textContent = scan.stage;
    byId('percent').textContent = `${scan.progress}%`;
    byId('progress').value = scan.progress;
    const titles = { queued: 'Queued', running: 'Scanning…', completed: 'Loading report…', failed: 'Failed' };
    byId('scan-heading').textContent = titles[scan.status];
    if (scan.status === 'completed') {
      loadingReport = true;
      byId('stage').textContent = 'Loading report…';
      renderReport(await request(`/scans/${activeScanId}/results`));
    } else if (scan.status === 'failed') {
      showError(scan.error || 'Scan failed. Start a new scan.');
    } else {
      pollTimer = setTimeout(poll, 700);
    }
  } catch (error) {
    if (error.status === 404 && !loadingReport) {
      byId('scan-heading').textContent = 'Scan not found';
      byId('progress-panel').hidden = true;
      showError('Scan not found.');
    } else {
      byId('scan-heading').textContent = loadingReport ? 'Report unavailable' : 'Connection interrupted';
      showError(error.message, true);
    }
  } finally {
    loading = false;
    byId('retry').disabled = false;
    byId('scan').setAttribute('aria-busy', 'false');
  }
}

function openScan(id) {
  activeScanId = id;
  byId('start').hidden = true;
  byId('scan').hidden = false;
  byId('scan-link').value = location.href;
  byId('scan-heading').focus();
  void poll();
}

byId('repository-url').addEventListener('input', () => {
  clearError();
  validateRepository(touchedRepository);
});
byId('repository-url').addEventListener('blur', () => {
  touchedRepository = true;
  validateRepository(Boolean(byId('repository-url').value.trim()));
});

byId('scan-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  touchedRepository = true;
  clearError();
  if (!validateRepository(true)) {
    byId('repository-url').focus();
    return;
  }
  submitting = true;
  byId('submit').disabled = true;
  byId('repository-url').disabled = true;
  byId('submit-spinner').hidden = false;
  byId('submit-label').textContent = 'Starting…';
  byId('scan-form').setAttribute('aria-busy', 'true');
  try {
    const { scanId } = await request('/scans', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repositoryUrl: byId('repository-url').value.trim() }),
    });
    history.replaceState(null, '', `/?scan=${encodeURIComponent(scanId)}`);
    openScan(scanId);
  } catch (error) {
    showError(error.message);
  } finally {
    submitting = false;
    byId('submit').disabled = false;
    byId('repository-url').disabled = false;
    byId('submit-spinner').hidden = true;
    byId('submit-label').textContent = 'Scan';
    byId('scan-form').setAttribute('aria-busy', 'false');
  }
});

byId('copy-link').addEventListener('click', async () => {
  byId('copy-link').disabled = true;
  try {
    await navigator.clipboard.writeText(byId('scan-link').value);
    byId('copy-feedback').textContent = 'Copied';
  } catch {
    byId('scan-link').hidden = false;
    byId('scan-link').focus();
    byId('scan-link').select();
    byId('copy-feedback').textContent = 'Copy the selected link.';
  } finally {
    byId('copy-feedback').hidden = false;
    byId('copy-link').disabled = false;
  }
});

byId('retry').addEventListener('click', () => void poll());
const scanId = new URLSearchParams(location.search).get('scan');
if (scanId) {
  if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(scanId)) openScan(scanId);
  else showError('Invalid scan link.');
}

