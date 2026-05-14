import { useFridayStore } from '../lib/state-store';

export function Cards() {
  const cards = useFridayStore((s) => s.cards);
  if (cards.length === 0) return null;
  return (
    <div className="cards">
      {cards.slice().reverse().map((c) => (
        <div key={c.id} className={`pane card ${c.tone ?? ''}`}>
          {c.title && <h4>{c.title}</h4>}
          {c.kind === 'card' && c.body && <p>{c.body}</p>}
          {c.kind === 'list' && c.items && (
            <ul>
              {c.items.map((it, i) => (
                <li key={i}>{it}</li>
              ))}
            </ul>
          )}
          {c.kind === 'image' && c.url && (
            <>
              <img src={c.url} alt={c.body ?? ''} />
              {c.body && <p style={{ marginTop: 6, opacity: 0.7, fontSize: 11 }}>{c.body}</p>}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
