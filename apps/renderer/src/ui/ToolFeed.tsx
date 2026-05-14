import { useFridayStore } from '../lib/state-store';

export function ToolFeed() {
  const tools = useFridayStore((s) => s.tools);
  if (tools.length === 0) return null;
  return (
    <div className="pane tool-feed">
      <h3>Tool activity</h3>
      {tools.slice().reverse().map((t) => (
        <div className="tool" key={t.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="name">{t.name}</span>
            <span className={`status ${t.status}`}>{t.status}</span>
          </div>
          {t.inputPreview && <div className="preview">in: {t.inputPreview}</div>}
          {t.outputPreview && <div className="preview">out: {t.outputPreview}</div>}
          {typeof t.durationMs === 'number' && (
            <div className="preview" style={{ opacity: 0.5 }}>{t.durationMs}ms</div>
          )}
        </div>
      ))}
    </div>
  );
}
