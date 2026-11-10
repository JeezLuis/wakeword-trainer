import { api } from '../api.ts';
import { h, section, toast } from '../dom.ts';
import { jobFor, jobPanel, render, startJob } from '../main.ts';
import { loadApp, state } from '../state.ts';

export async function setupView() {
  await loadApp();
  const app = state.app!;
  const missing = app.setup.filter((s) => !s.ok);
  const running = app.job?.status === 'running';
  const job = jobFor(null);
  const totalMB = missing.reduce((a, s) => a + s.sizeMB - (s.partialMB ?? 0), 0);

  return h(
    'div',
    null,
    h('h1', null, 'Setup'),
    h(
      'p',
      { class: 'lead' },
      'Training needs a few things downloaded once (about 2.5 GB in total, into the ',
      h('code', null, 'data/'),
      ' folder). Downloads resume if interrupted.',
    ),
    section(
      'What is needed',
      null,
      h(
        'ul',
        { class: 'checklist' },
        app.setup.map((s) =>
          h(
            'li',
            { class: s.ok ? 'ok' : s.required ? 'missing' : 'optional' },
            h('span', { class: 'mark' }, s.ok ? '✓' : s.required ? '!' : '○'),
            h(
              'div',
              null,
              h('strong', null, s.label),
              h('span', { class: 'muted' }, ` · ${s.sizeMB >= 1000 ? `${(s.sizeMB / 1000).toFixed(1)} GB` : `${s.sizeMB} MB`}${s.required ? '' : ' · optional, recommended'}`),
              h('div', { class: 'help' }, s.description),
              s.partialMB ? h('div', { class: 'muted' }, `${s.partialMB} MB already downloaded, will resume.`) : null,
              s.error ? h('pre', { class: 'error-box' }, s.error) : null,
            ),
            !s.ok ? h('button', { disabled: running, onclick: () => startJob({ steps: ['setup'], options: { only: [s.id] } }) }, 'Download') : null,
          ),
        ),
      ),
      h(
        'div',
        { class: 'row' },
        missing.length
          ? h('button', { class: 'primary', disabled: running, onclick: () => startJob({ steps: ['setup'] }) }, `Download everything missing (~${(totalMB / 1000).toFixed(1)} GB)`)
          : h('p', { class: 'success' }, '✓ Everything is ready.'),
        h(
          'button',
          {
            class: 'ghost',
            onclick: async () => {
              await api('/api/setup/recheck', { method: 'POST' });
              toast('Checked again');
              void render();
            },
          },
          'Check again',
        ),
      ),
      app.setup.find((s) => s.id === 'chromium' && s.error)
        ? h(
            'p',
            { class: 'help' },
            'If Chromium is installed but cannot start, it is usually missing system libraries. On Debian/Ubuntu: ',
            h('code', null, 'sudo npx playwright install-deps chromium'),
            '. See "Troubleshooting" in the README for a way without admin rights.',
          )
        : null,
    ),
    job ? section('Progress', null, jobPanel(job)) : null,
    !missing.some((s) => s.required) && !running
      ? h('div', { class: 'next' }, h('a', { class: 'button primary', href: app.words.length ? '#/' : '#/new' }, app.words.length ? 'Continue →' : 'Create your first wake word →'))
      : null,
  );
}
