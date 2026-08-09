import { type FormEventHandler, type ReactNode, useId } from "react";

export function SettingsGroup({
  as = "section",
  children,
  className = "",
  description,
  icon,
  title,
  onSubmit,
}: {
  as?: "form" | "section";
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
}) {
  const headingId = useId();
  const classes = `settings-group${className ? ` ${className}` : ""}`;
  const contents = (
    <>
      <div className="settings-group-heading">
        {icon && (
          <span aria-hidden="true" className="settings-group-icon">
            {icon}
          </span>
        )}
        <div>
          <h2 id={headingId}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
      </div>
      <div className="settings-group-body">{children}</div>
    </>
  );

  if (as === "form") {
    return (
      <form aria-labelledby={headingId} className={classes} onSubmit={onSubmit}>
        {contents}
      </form>
    );
  }
  return (
    <section aria-labelledby={headingId} className={classes}>
      {contents}
    </section>
  );
}

export function SettingsRow({
  children,
  className = "",
  description,
  label,
  labelFor,
}: {
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  label: ReactNode;
  labelFor?: string;
}) {
  return (
    <div className={`settings-row${className ? ` ${className}` : ""}`}>
      <div className="settings-row-copy">
        {labelFor ? <label htmlFor={labelFor}>{label}</label> : <strong>{label}</strong>}
        {description && <p>{description}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}
