export function SettingsPage(): JSX.Element {
  return (
    <div className="detail">
      <h1>Settings</h1>
      <p className="empty">
        Audit retention, UI theme, daemon port, and log level live here in v1.1.
      </p>
      <p className="empty">
        Per ADR-0006, the schema is already in place; the editor UI is deferred.
      </p>
    </div>
  );
}
