// Progressive enhancement only: every page works without this script.
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- welcome: the ticket opens the curtains, then we walk through ----
  var open = document.querySelector('[data-open-curtains]');
  if (open) {
    open.addEventListener('click', function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      var href = open.getAttribute('href');
      if (reduce) { window.location.href = href; return; }
      document.documentElement.classList.add('curtains-open');
      window.setTimeout(function () { window.location.href = href; }, 1500);
    });
  }

  // ---- title pickers: type, pick a suggestion, get a chip; a hidden textarea carries the lines to the server ----
  document.querySelectorAll('.picker').forEach(function (picker) {
    var area = picker.querySelector('textarea');
    var input = picker.querySelector('input[type=search]');
    var chipsOut = picker.querySelector('.chips-out');
    var list = picker.querySelector('.suggest');
    var timer;
    var items = [];
    area.hidden = true;
    input.hidden = false;
    picker.querySelector('.nojs-help').hidden = true;

    function lines() { return area.value.split(/[\n;]+/).map(function (s) { return s.trim(); }).filter(Boolean); }
    function draw() {
      chipsOut.textContent = '';
      lines().forEach(function (line, i) {
        var chip = document.createElement('span');
        chip.className = 'pick-chip';
        chip.appendChild(document.createTextNode(line));
        var x = document.createElement('button');
        x.type = 'button';
        x.setAttribute('aria-label', 'Remove ' + line);
        x.textContent = '×';
        x.addEventListener('click', function () { var l = lines(); l.splice(i, 1); area.value = l.join('\n'); draw(); });
        chip.appendChild(x);
        chipsOut.appendChild(chip);
      });
    }
    function add(text) {
      text = text.trim();
      if (!text) return;
      var l = lines();
      if (l.indexOf(text) === -1) l.push(text);
      area.value = l.join('\n');
      input.value = '';
      list.hidden = true;
      draw();
    }
    function show(results) {
      items = results;
      list.textContent = '';
      list.hidden = results.length === 0;
      results.forEach(function (r) {
        var b = document.createElement('button');
        b.type = 'button';
        b.appendChild(document.createTextNode(r.title + ' (' + r.year + ') '));
        var s = document.createElement('small');
        s.textContent = r.director || '';
        b.appendChild(s);
        b.addEventListener('click', function () { add(r.title + ' (' + r.year + ')'); input.focus(); });
        list.appendChild(b);
      });
    }
    input.addEventListener('input', function () {
      window.clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) { show([]); return; }
      timer = window.setTimeout(function () {
        fetch('/api/suggest?q=' + encodeURIComponent(q)).then(function (r) { return r.json(); }).then(show).catch(function () { show([]); });
      }, 160);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); add(items.length && items[0] ? items[0].title + ' (' + items[0].year + ')' : input.value); }
      if (e.key === 'Escape') list.hidden = true;
    });
    document.addEventListener('click', function (e) { if (!picker.contains(e.target)) list.hidden = true; });
    draw();
  });

  // ---- live agent log ----
  var run = document.getElementById('run');
  if (run) {
    var stepsEl = document.getElementById('steps');
    var nowEl = document.getElementById('now');
    var seen = parseInt(run.dataset.seen || '0', 10);
    var el = function (tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
    var poll = function () {
      fetch(run.dataset.status).then(function (r) { return r.json(); }).then(function (j) {
        for (; seen < j.steps.length; seen++) {
          var s = j.steps[seen];
          var li = el('li', s.status === 'warn' ? 'warn' : '');
          li.appendChild(el('span', 'n', String(s.n).padStart(2, '0')));
          var body = el('span');
          body.appendChild(el('span', 'tool', s.tool.replace(/_/g, ' ')));
          body.appendChild(document.createTextNode(' — ' + s.summary));
          li.appendChild(body);
          stepsEl.appendChild(li);
        }
        nowEl.textContent = j.status === 'running' ? (j.current || 'Thinking') : '';
        if (j.status === 'done') { window.location.href = run.dataset.results; return; }
        if (j.status === 'error') { window.location.reload(); return; }
        window.setTimeout(poll, 800);
      }).catch(function () { window.setTimeout(poll, 2000); });
    };
    poll();
  }

  // ---- copy invite link ----
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.dataset.copy;
      var done = function () { var old = btn.textContent; btn.textContent = 'Copied'; window.setTimeout(function () { btn.textContent = old; }, 1600); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy this link', text); });
      else window.prompt('Copy this link', text);
    });
  });
})();
