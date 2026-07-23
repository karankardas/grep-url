// ============================================================
// Worker source: does all regex scanning off the main thread,
// reading each file in chunks so a 50MB+ file never gets loaded
// into memory as one giant string and never blocks the UI.
// ============================================================
const WORKER_SRC = `
  const CHUNK_SIZE = 6 * 1024 * 1024;   // 6MB per read
  const OVERLAP = 3000;                  // chars carried into next chunk so matches spanning a boundary aren't lost
  const SAFE_MARGIN = 1200;              // don't commit matches this close to a non-final chunk's edge (might be truncated)

  const URL_RE = /\\bhttps?:\\/\\/[^\\s"'\`<>\\)\\]\\}\\\\]+/g;
  const ENDPOINT_RE = /(["'\`])(\\/(?!\\/)[a-zA-Z0-9_][a-zA-Z0-9_\\-\\.\\/\\{\\}\\$]*)\\1/g;
  const QUERY_PARAM_RE = /[?&]([a-zA-Z_][a-zA-Z0-9_\\-]{0,50})=/g;
  const FORM_NAME_RE = /\\bname=["']([a-zA-Z0-9_\\-\\[\\]]{1,60})["']/g;
  const REQ_PARAM_RE = /\\breq\\.(?:query|params|body)\\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  const PHP_PARAM_RE = /\\$_(?:GET|POST|REQUEST)\\[['"]([a-zA-Z0-9_]+)['"]\\]/g;
  const STATIC_EXT = /\\.(png|jpe?g|gif|svg|webp|woff2?|ttf|eot|ico|css|map)(\\?.*)?$/i;

  function trimUrl(u){ return u.replace(/[,.;:'"\\)\\]\\}]+$/, ''); }

  function committable(endIdx, len, isLast){
    return isLast || (len - endIdx) > SAFE_MARGIN;
  }

  function scanChunk(text, isLast, local){
    let m;
    URL_RE.lastIndex = 0;
    while((m = URL_RE.exec(text))){
      if(!committable(m.index + m[0].length, text.length, isLast)) continue;
      const url = trimUrl(m[0]);
      local.urls.add(url);
      const qIdx = url.indexOf('?');
      if(qIdx !== -1){
        let qm; QUERY_PARAM_RE.lastIndex = 0;
        const qs = url.slice(qIdx);
        while((qm = QUERY_PARAM_RE.exec(qs))) local.params.add(qm[1]);
      }
    }
    ENDPOINT_RE.lastIndex = 0;
    while((m = ENDPOINT_RE.exec(text))){
      if(!committable(m.index + m[0].length, text.length, isLast)) continue;
      const path = m[2];
      if(path.length < 2 || STATIC_EXT.test(path)) continue;
      local.endpoints.add(path);
    }
    QUERY_PARAM_RE.lastIndex = 0;
    while((m = QUERY_PARAM_RE.exec(text))){
      if(!committable(m.index + m[0].length, text.length, isLast)) continue;
      local.params.add(m[1]);
    }
    FORM_NAME_RE.lastIndex = 0;
    while((m = FORM_NAME_RE.exec(text))){
      if(!committable(m.index + m[0].length, text.length, isLast)) continue;
      local.params.add(m[1]);
    }
    REQ_PARAM_RE.lastIndex = 0;
    while((m = REQ_PARAM_RE.exec(text))){
      if(!committable(m.index + m[0].length, text.length, isLast)) continue;
      local.params.add(m[1]);
    }
    PHP_PARAM_RE.lastIndex = 0;
    while((m = PHP_PARAM_RE.exec(text))){
      if(!committable(m.index + m[0].length, text.length, isLast)) continue;
      local.params.add(m[1]);
    }
  }

  self.onmessage = async (e) => {
    const { file, jobId } = e.data;
    const local = { urls: new Set(), endpoints: new Set(), params: new Set() };
    try{
      let offset = 0, tail = '';
      while(offset < file.size){
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const chunkText = await file.slice(offset, end).text();
        const combined = tail + chunkText;
        const isLast = end === file.size;
        scanChunk(combined, isLast, local);
        tail = combined.slice(-OVERLAP);
        offset = end;
        self.postMessage({ type:'progress', jobId, name:file.name, loaded:end, total:file.size });
      }
      self.postMessage({
        type:'done', jobId, name:file.name, size:file.size,
        urls:[...local.urls], endpoints:[...local.endpoints], params:[...local.params]
      });
    }catch(err){
      self.postMessage({ type:'error', jobId, name:file.name, message:String(err && err.message || err) });
    }
  };
`;

(function(){
  const dropzone = document.getElementById('drop');
  const fileInput = document.getElementById('fileInput');
  const filelistEl = document.getElementById('filelist');
  const logEl = document.getElementById('log');
  const statsEl = document.getElementById('stats');
  const toolbarEl = document.getElementById('toolbar');
  const gridEl = document.getElementById('grid');
  const filterInput = document.getElementById('filterInput');
  const filterHint = document.getElementById('filterHint');
  const toastEl = document.getElementById('toast');
  const progressWrap = document.getElementById('progressWrap');
  const progressLabel = document.getElementById('progressLabel');
  const progressFill = document.getElementById('progressFill');
  const cancelBtn = document.getElementById('cancelScan');
  const paneFilterInputs = {
    urls: document.getElementById('filterUrls'),
    endpoints: document.getElementById('filterEndpoints'),
    params: document.getElementById('filterParams')
  };

  const PAGE_SIZE = 250;
  // data[category] = Map(value -> Set(filenames))
  const data = { urls: new Map(), endpoints: new Map(), params: new Map() };
  // per-file cache of just the unique matches it produced (NOT full text) — cheap to keep around, lets us rebuild on file removal without re-reading the file
  const scannedFiles = [];
  const paneState = { urls: PAGE_SIZE, endpoints: PAGE_SIZE, params: PAGE_SIZE };

  let worker = null;
  let jobId = 0;
  let queue = [];
  let cancelled = false;

  function makeWorker(){
    const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
  }

  function addMatch(cat, value, filename){
    if(!value) return;
    if(!data[cat].has(value)) data[cat].set(value, new Set());
    data[cat].get(value).add(filename);
  }

  function logLine(text, cls){
    const d = document.createElement('div');
    if(cls) d.className = cls;
    d.innerHTML = text;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function renderChips(){
    filelistEl.innerHTML = '';
    scannedFiles.forEach((f, i) => {
      const chip = document.createElement('div');
      chip.className = 'filechip';
      chip.innerHTML = `<span>${escapeHtml(f.name)}</span><span class="n">${formatBytes(f.size)}</span>`;
      const btn = document.createElement('button');
      btn.textContent = '\u00d7';
      btn.setAttribute('aria-label', 'remove ' + f.name);
      btn.onclick = () => removeFile(i);
      chip.appendChild(btn);
      filelistEl.appendChild(chip);
    });
  }

  function removeFile(idx){
    scannedFiles.splice(idx, 1);
    data.urls.clear(); data.endpoints.clear(); data.params.clear();
    // rebuild from cached per-file match lists — cheap, no re-reading needed
    scannedFiles.forEach(f => {
      f.matches.urls.forEach(v => addMatch('urls', v, f.name));
      f.matches.endpoints.forEach(v => addMatch('endpoints', v, f.name));
      f.matches.params.forEach(v => addMatch('params', v, f.name));
    });
    renderChips();
    resetPagination();
    renderAll();
    if(scannedFiles.length === 0){
      statsEl.classList.remove('show');
      toolbarEl.classList.remove('show'); filterHint.classList.remove('show');
      gridEl.classList.remove('show');
    }
  }

  function formatBytes(n){
    if(n < 1024) return n + 'B';
    if(n < 1024*1024) return (n/1024).toFixed(1) + 'KB';
    return (n/1024/1024).toFixed(1) + 'MB';
  }

  function escapeHtml(s){
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ---------- query parsing ----------
  // Supports: plain terms (AND, substring, case-insensitive), "exact phrase",
  // -exclude / !exclude terms, and /regex/flags tokens.
  function tokenize(q){
    const tokens = [];
    const re = /"([^"]*)"|\/((?:\\.|[^\/])+)\/([a-z]*)|(\S+)/g;
    let m;
    while((m = re.exec(q))){
      if(m[1] !== undefined){
        tokens.push({ kind:'phrase', neg:false, value:m[1] });
      } else if(m[2] !== undefined){
        tokens.push({ kind:'regex', neg:false, value:m[2], flags:m[3] || '' });
      } else if(m[4] !== undefined){
        let raw = m[4];
        let neg = false;
        if(raw.startsWith('-') || raw.startsWith('!')){ neg = true; raw = raw.slice(1); }
        if(raw) tokens.push({ kind:'term', neg, value:raw });
      }
    }
    return tokens;
  }

  function parseQuery(q){
    if(!q || !q.trim()) return null;
    const tokens = tokenize(q.trim());
    return tokens.map(t => {
      let regex = null;
      try{
        if(t.kind === 'regex') regex = new RegExp(t.value, t.flags.includes('i') ? t.flags : t.flags + 'i');
        else regex = new RegExp(t.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      }catch(e){ regex = null; }
      return { ...t, regex };
    });
  }

  function matchesTokens(value, tokens){
    if(!tokens || tokens.length === 0) return true;
    for(const t of tokens){
      if(!t.regex) continue;
      const hit = t.regex.test(value);
      if(t.neg && hit) return false;
      if(!t.neg && !hit) return false;
    }
    return true;
  }

  function combinedTokens(cat){
    const globalQ = filterInput.value;
    const localQ = paneFilterInputs[cat] ? paneFilterInputs[cat].value : '';
    const g = parseQuery(globalQ) || [];
    const l = parseQuery(localQ) || [];
    const combined = [...g, ...l];
    return combined.length ? combined : null;
  }

  function highlight(text, tokens){
    const esc = escapeHtml(text);
    if(!tokens) return esc;
    const positive = tokens.filter(t => !t.neg && t.regex);
    if(positive.length === 0) return esc;
    // build a single alternation so overlapping/adjacent matches don't double-wrap
    const parts = positive.map(t => t.kind === 'regex' ? t.value : t.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    try{
      const combinedRe = new RegExp('(' + parts.join('|') + ')', 'ig');
      return esc.replace(combinedRe, '<mark>$1</mark>');
    }catch(e){ return esc; }
  }

  function resetPagination(){
    paneState.urls = PAGE_SIZE; paneState.endpoints = PAGE_SIZE; paneState.params = PAGE_SIZE;
  }

  function renderPane(cat, containerId, countId){
    const container = document.getElementById(containerId);
    const tokens = combinedTokens(cat);
    const entries = [...data[cat].entries()]
      .filter(([val]) => matchesTokens(val, tokens))
      .sort((a,b) => a[0].localeCompare(b[0]));

    document.getElementById(countId).textContent = data[cat].size;
    container.innerHTML = '';

    if(entries.length === 0){
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = data[cat].size === 0 ? 'nothing found yet' : 'no matches for filter';
      container.appendChild(e);
      return;
    }

    const limit = paneState[cat];
    const shown = entries.slice(0, limit);
    const frag = document.createDocumentFragment();
    shown.forEach(([val, files], i) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.title = 'seen in: ' + [...files].slice(0,20).join(', ') + (files.size > 20 ? ' …' : '') + '  (click to copy)';
      row.innerHTML = `<span class="ln">${i+1}</span><span class="val">${highlight(val, tokens)}</span><span class="cnt">${files.size}</span>`;
      row.onclick = () => copyToClipboard(val);
      frag.appendChild(row);
    });
    container.appendChild(frag);

    if(entries.length > limit){
      const more = document.createElement('div');
      more.className = 'more-row';
      more.textContent = `show ${Math.min(PAGE_SIZE, entries.length - limit)} more (${entries.length - limit} remaining)`;
      more.onclick = () => { paneState[cat] += PAGE_SIZE; renderPane(cat, containerId, countId); };
      container.appendChild(more);
    }
  }

  function renderAll(){
    renderPane('urls', 'paneUrls', 'cUrls');
    renderPane('endpoints', 'paneEndpoints', 'cEndpoints');
    renderPane('params', 'paneParams', 'cParams');
    document.getElementById('statFiles').textContent = scannedFiles.length;
    document.getElementById('statUrls').textContent = data.urls.size;
    document.getElementById('statEndpoints').textContent = data.endpoints.size;
    document.getElementById('statParams').textContent = data.params.size;
    updateActionLabels();
  }

  function copyToClipboard(text){
    navigator.clipboard.writeText(text).then(() => showToast('copied: ' + (text.length > 40 ? text.slice(0,40)+'…' : text)));
  }

  function showToast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove('show'), 1600);
  }

  function setProgress(name, loaded, total){
    const pct = total ? Math.min(100, Math.round((loaded/total)*100)) : 0;
    progressFill.style.width = pct + '%';
    progressLabel.innerHTML = `scanning <b>${escapeHtml(name)}</b> — ${pct}% (${formatBytes(loaded)}/${formatBytes(total)})`;
  }

  function processNext(){
    if(cancelled || queue.length === 0){
      progressWrap.classList.remove('show');
      dropzone.style.pointerEvents = '';
      dropzone.style.opacity = '';
      renderChips();
      resetPagination();
      renderAll();
      if(scannedFiles.length > 0){
        statsEl.classList.add('show');
        toolbarEl.classList.add('show'); filterHint.classList.add('show');
        gridEl.classList.add('show');
      }
      return;
    }
    const file = queue.shift();
    const id = ++jobId;
    progressWrap.classList.add('show');
    setProgress(file.name, 0, file.size);
    worker.postMessage({ file, jobId: id });
  }

  function startScan(files){
    if(!worker) worker = makeWorker();
    cancelled = false;
    queue.push(...files);
    logEl.classList.add('show');
    dropzone.style.pointerEvents = 'none';
    dropzone.style.opacity = '0.5';

    worker.onmessage = (e) => {
      const msg = e.data;
      if(msg.type === 'progress'){
        setProgress(msg.name, msg.loaded, msg.total);
      } else if(msg.type === 'done'){
        const matches = { urls: msg.urls, endpoints: msg.endpoints, params: msg.params };
        scannedFiles.push({ name: msg.name, size: msg.size, matches });
        matches.urls.forEach(v => addMatch('urls', v, msg.name));
        matches.endpoints.forEach(v => addMatch('endpoints', v, msg.name));
        matches.params.forEach(v => addMatch('params', v, msg.name));
        logLine(`<span class="ok">[+] scanned <b>${escapeHtml(msg.name)}</b> — ${formatBytes(msg.size)} — ${matches.urls.length} urls, ${matches.endpoints.length} endpoints, ${matches.params.length} params</span>`);
        processNext();
      } else if(msg.type === 'error'){
        logLine(`<span class="err">[!] failed to scan ${escapeHtml(msg.name)}: ${escapeHtml(msg.message)}</span>`);
        processNext();
      }
    };
    processNext();
  }

  cancelBtn.addEventListener('click', () => {
    cancelled = true;
    queue = [];
    if(worker){ worker.terminate(); worker = null; }
    progressWrap.classList.remove('show');
    dropzone.style.pointerEvents = '';
    dropzone.style.opacity = '';
    logLine('[!] scan cancelled');
    renderChips();
    resetPagination();
    renderAll();
    if(scannedFiles.length > 0){
      statsEl.classList.add('show');
      toolbarEl.classList.add('show'); filterHint.classList.add('show');
      gridEl.classList.add('show');
    }
  });

  // ---------- events ----------
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', e => { if(e.target.files.length) startScan([...e.target.files]); fileInput.value=''; });

  ['dragenter','dragover'].forEach(evt => dropzone.addEventListener(evt, e => {
    e.preventDefault(); dropzone.classList.add('drag');
  }));
  ['dragleave','drop'].forEach(evt => dropzone.addEventListener(evt, e => {
    e.preventDefault(); dropzone.classList.remove('drag');
  }));
  dropzone.addEventListener('drop', e => {
    if(e.dataTransfer.files.length) startScan([...e.dataTransfer.files]);
  });

  filterInput.addEventListener('input', () => { resetPagination(); renderAll(); });

  const paneRenderMap = {
    urls: ['paneUrls','cUrls'],
    endpoints: ['paneEndpoints','cEndpoints'],
    params: ['paneParams','cParams']
  };
  Object.entries(paneFilterInputs).forEach(([cat, input]) => {
    input.addEventListener('input', () => {
      input.classList.toggle('active', input.value.trim().length > 0);
      paneState[cat] = PAGE_SIZE;
      const [containerId, countId] = paneRenderMap[cat];
      renderPane(cat, containerId, countId);
      updateActionLabels();
    });
  });

  function anyFilterActive(){
    if(filterInput.value.trim()) return true;
    return Object.values(paneFilterInputs).some(i => i.value.trim());
  }

  function filteredEntries(cat){
    const tokens = combinedTokens(cat);
    return [...data[cat].entries()]
      .filter(([val]) => matchesTokens(val, tokens))
      .sort((a,b) => a[0].localeCompare(b[0]));
  }

  function updateActionLabels(){
    const active = anyFilterActive();
    document.getElementById('exportJson').textContent = active ? 'export filtered .json' : 'export .json';
    document.getElementById('exportTxt').textContent = active ? 'export filtered .txt' : 'export .txt';
    document.querySelectorAll('.icon-btn[data-copy]').forEach(btn => {
      btn.textContent = active ? 'copy filtered' : 'copy all';
    });
  }

  document.querySelectorAll('.icon-btn[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.getAttribute('data-copy');
      const entries = filteredEntries(cat);
      const list = entries.map(([val]) => val).join('\n');
      if(!list){ showToast('nothing to copy'); return; }
      const active = anyFilterActive();
      navigator.clipboard.writeText(list).then(() => showToast(`${active ? 'filtered ' : ''}${cat} copied (${entries.length}/${data[cat].size})`));
    });
  });

  document.getElementById('exportJson').addEventListener('click', () => {
    const out = {};
    for(const cat of ['urls','endpoints','params']){
      out[cat] = filteredEntries(cat).map(([value, files]) => ({ value, sources: [...files] }));
    }
    const active = anyFilterActive();
    downloadFile(active ? 'scan-results-filtered.json' : 'scan-results.json', JSON.stringify(out, null, 2), 'application/json');
  });

  document.getElementById('exportTxt').addEventListener('click', () => {
    let out = '';
    const active = anyFilterActive();
    for(const [cat,label] of [['urls','URLS'],['endpoints','ENDPOINTS'],['params','PARAMETERS']]){
      const entries = filteredEntries(cat);
      out += `# ${label} (${entries.length}${active ? ' of ' + data[cat].size : ''})\n`;
      out += entries.map(([val]) => val).join('\n');
      out += '\n\n';
    }
    downloadFile(active ? 'scan-results-filtered.txt' : 'scan-results.txt', out, 'text/plain');
  });

  document.getElementById('clearAll').addEventListener('click', () => {
    cancelled = true; queue = [];
    if(worker){ worker.terminate(); worker = null; }
    scannedFiles.length = 0;
    data.urls.clear(); data.endpoints.clear(); data.params.clear();
    filelistEl.innerHTML = '';
    logEl.innerHTML = '';
    logEl.classList.remove('show');
    progressWrap.classList.remove('show');
    statsEl.classList.remove('show');
    toolbarEl.classList.remove('show'); filterHint.classList.remove('show');
    gridEl.classList.remove('show');
    dropzone.style.pointerEvents = '';
    dropzone.style.opacity = '';
    fileInput.value = '';
    filterInput.value = '';
    Object.values(paneFilterInputs).forEach(input => { input.value = ''; input.classList.remove('active'); });
    resetPagination();
    updateActionLabels();
  });

  function downloadFile(filename, content, mime){
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('downloaded ' + filename);
  }
})();
