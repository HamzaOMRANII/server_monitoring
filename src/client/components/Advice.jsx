// Findings list shared by the per-app page and the security page: level tag,
// title, explanation, and commands with a copy button.
import { useState } from 'react';

const LEVEL_WORD = { crit: 'problem', warn: 'warning', info: 'note', ok: 'ok' };

export default function Advice({ items }) {
  return (
    <div className="advice">
      {items.map((a, i) => (
        <div key={i} className={`advice-item lv-${a.level}`}>
          <div className="advice-head"><span className={`lv-tag lv-${a.level}`}>{LEVEL_WORD[a.level]}</span><strong>{a.title}</strong></div>
          <p>{a.detail}</p>
          {a.commands.length > 0 && (
            <div className="advice-cmds">
              {a.commands.map((c) => <CopyCmd key={c} cmd={c} />)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function CopyCmd({ cmd }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(cmd.replace(/\s+#.*$/, '')); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* no clipboard */ }
  };
  return (
    <div className="cmd">
      <code>{cmd}</code>
      <button type="button" className="link-btn" onClick={copy}>{done ? 'copied' : 'copy'}</button>
    </div>
  );
}

