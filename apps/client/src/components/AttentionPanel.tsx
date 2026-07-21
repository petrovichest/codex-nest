import { Browser } from "@capacitor/browser";
import { useEffect, useState } from "react";

import type {
  AttentionRequest,
  AttentionResponse,
  ElicitationPrimitive,
  PermissionGrant,
} from "@codexnest/protocol";

import { useConnection } from "../connection";
import { AlertIcon } from "./Icons";

export function AttentionPanel({ requests }: { requests: AttentionRequest[] }) {
  if (!requests.length) return null;
  return (
    <section className="attention-stack" aria-label="Требуется внимание">
      {requests.map((request) => (
        <AttentionCard request={request} key={request.id} />
      ))}
    </section>
  );
}

function AttentionCard({ request }: { request: AttentionRequest }) {
  const { api } = useConnection();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function respond(response: AttentionResponse) {
    setBusy(true);
    setError(null);
    try {
      await api.respond(request.id, response);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Запрос уже закрыт");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="attention-card">
      <div className="attention-heading">
        <AlertIcon />
        Требуется внимание
      </div>
      {request.kind === "commandApproval" && (
        <>
          <h3>Разрешить команду?</h3>
          {request.reason && <p>{request.reason}</p>}
          <pre>{request.command ?? "Команда не указана"}</pre>
          {request.cwd && <div className="path">{request.cwd}</div>}
          {request.networkHost && <div className="path">Сетевой host: {request.networkHost}</div>}
          {!!request.proposedPolicyChanges.length && (
            <div className="policy-change">
              <strong>Отдельные изменения policy</strong>
              {request.proposedPolicyChanges.map((change) => (
                <button
                  key={change.id}
                  disabled={busy}
                  onClick={() =>
                    void respond({ kind: "approvalAmendment", amendmentId: change.id })
                  }
                >
                  {change.label}
                </button>
              ))}
              <small>Обычное подтверждение эти правила не применяет.</small>
            </div>
          )}
          <ApprovalButtons busy={busy} canSession={request.canAcceptForSession} respond={respond} />
        </>
      )}
      {request.kind === "fileChangeApproval" && (
        <>
          <h3>Разрешить изменения файлов?</h3>
          {request.reason && <p>{request.reason}</p>}
          {request.grantRoot && <div className="path">Запрошенный корень: {request.grantRoot}</div>}
          <ApprovalButtons busy={busy} canSession={request.canAcceptForSession} respond={respond} />
        </>
      )}
      {request.kind === "permissionApproval" && (
        <PermissionForm request={request} busy={busy} respond={respond} />
      )}
      {request.kind === "userInput" && (
        <UserInputForm request={request} busy={busy} respond={respond} />
      )}
      {request.kind === "elicitation" && (
        <ElicitationForm request={request} busy={busy} respond={respond} />
      )}
      {request.kind === "unsupported" && (
        <>
          <h3>Несовместимое действие</h3>
          <p>{request.message}</p>
          <code>{request.method}</code>
        </>
      )}
      {error && <div className="error-banner">{error}</div>}
    </article>
  );
}

function ApprovalButtons({
  busy,
  canSession,
  respond,
}: {
  busy: boolean;
  canSession: boolean;
  respond(response: AttentionResponse): Promise<void>;
}) {
  const decision = (value: "accept" | "acceptForSession" | "decline" | "cancel") =>
    void respond({ kind: "approval", decision: value });
  return (
    <div className="button-row">
      <button className="primary" disabled={busy} onClick={() => decision("accept")}>
        Разрешить один раз
      </button>
      {canSession && (
        <button disabled={busy} onClick={() => decision("acceptForSession")}>
          На сессию
        </button>
      )}
      <button className="danger" disabled={busy} onClick={() => decision("decline")}>
        Отказать
      </button>
      <button disabled={busy} onClick={() => decision("cancel")}>
        Отменить turn
      </button>
    </div>
  );
}

function PermissionForm({
  request,
  busy,
  respond,
}: {
  request: Extract<AttentionRequest, { kind: "permissionApproval" }>;
  busy: boolean;
  respond(response: AttentionResponse): Promise<void>;
}) {
  const [grant, setGrant] = useState<PermissionGrant>({});
  const paths = [
    ...(request.permissions.fileSystem?.read ?? []).map((path) => ({
      mode: "read" as const,
      path,
    })),
    ...(request.permissions.fileSystem?.write ?? []).map((path) => ({
      mode: "write" as const,
      path,
    })),
  ];
  function togglePath(mode: "read" | "write", path: string, checked: boolean) {
    const current = grant.fileSystem?.[mode] ?? [];
    setGrant({
      ...grant,
      fileSystem: {
        ...grant.fileSystem,
        [mode]: checked ? [...current, path] : current.filter((candidate) => candidate !== path),
      },
    });
  }
  return (
    <>
      <h3>Дополнительные разрешения</h3>
      {request.reason && <p>{request.reason}</p>}
      <div className="path">{request.cwd}</div>
      {request.permissions.network?.enabled && (
        <label className="check">
          <input
            type="checkbox"
            checked={grant.network?.enabled ?? false}
            onChange={(event) => setGrant({ ...grant, network: { enabled: event.target.checked } })}
          />
          Сеть
        </label>
      )}
      {paths.map(({ mode, path }) => (
        <label className="check" key={`${mode}-${path}`}>
          <input
            type="checkbox"
            checked={grant.fileSystem?.[mode]?.includes(path) ?? false}
            onChange={(event) => togglePath(mode, path, event.target.checked)}
          />
          {mode === "read" ? "Чтение" : "Запись"}: {path}
        </label>
      ))}
      <div className="button-row">
        <button
          className="primary"
          disabled={busy}
          onClick={() => void respond({ kind: "permission", permissions: grant, scope: "turn" })}
        >
          Выдать на turn
        </button>
        <button
          disabled={busy}
          onClick={() => void respond({ kind: "permission", permissions: grant, scope: "session" })}
        >
          На сессию
        </button>
        <button
          className="danger"
          disabled={busy}
          onClick={() => void respond({ kind: "permission", permissions: {}, scope: "turn" })}
        >
          Отказать
        </button>
      </div>
    </>
  );
}

function UserInputForm({
  request,
  busy,
  respond,
}: {
  request: Extract<AttentionRequest, { kind: "userInput" }>;
  busy: boolean;
  respond(response: AttentionResponse): Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const question = request.questions[questionIndex];
  const isLastQuestion = questionIndex === request.questions.length - 1;
  const currentAnswer = question ? answers[question.id]?.[0]?.trim() : "";

  function updateAnswer(questionId: string, answer: string) {
    setAnswers((current) => ({ ...current, [questionId]: [answer] }));
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!question || !currentAnswer) return;
        if (!isLastQuestion) {
          setQuestionIndex((current) => current + 1);
          return;
        }
        void respond({ kind: "userInput", answers });
      }}
    >
      <h3>Codex просит уточнение</h3>
      {request.autoResolutionMs !== null && (
        <Countdown deadline={request.createdAt + request.autoResolutionMs} />
      )}
      {question && (
        <>
          <div className="user-input-progress">
            Вопрос {questionIndex + 1} из {request.questions.length}
          </div>
          <fieldset key={question.id}>
            <legend>{question.header}</legend>
            <p>{question.question}</p>
            {question.options?.map((option) => (
              <label className="check" key={option.label}>
                <input
                  type="radio"
                  name={question.id}
                  value={option.label}
                  checked={answers[question.id]?.[0] === option.label}
                  onChange={() => updateAnswer(question.id, option.label)}
                  required={!question.isOther}
                />
                <span>
                  {option.label}
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
            {(question.isOther || !question.options) && (
              <input
                type={question.isSecret ? "password" : "text"}
                placeholder="Свой ответ"
                value={
                  question.options?.some((option) => option.label === answers[question.id]?.[0])
                    ? ""
                    : (answers[question.id]?.[0] ?? "")
                }
                onChange={(event) => updateAnswer(question.id, event.target.value)}
                required={!answers[question.id]?.[0]}
              />
            )}
          </fieldset>
          <button className="primary" disabled={busy || !currentAnswer}>
            {isLastQuestion ? "Отправить ответы" : "Далее"}
          </button>
        </>
      )}
    </form>
  );
}

function Countdown({ deadline }: { deadline: number }) {
  const [seconds, setSeconds] = useState(() =>
    Math.max(0, Math.ceil((deadline - Date.now()) / 1_000)),
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      setSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1_000)));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return (
    <div className="timer">
      {seconds > 0 ? `Автовыбор через ${seconds} сек.` : "Время автовыбора истекло"}
    </div>
  );
}

function ElicitationForm({
  request,
  busy,
  respond,
}: {
  request: Extract<AttentionRequest, { kind: "elicitation" }>;
  busy: boolean;
  respond(response: AttentionResponse): Promise<void>;
}) {
  const [content, setContent] = useState<Record<string, unknown>>({});
  const [validationError, setValidationError] = useState<string | null>(null);
  if (request.mode === "url") {
    return (
      <>
        <h3>Действие во внешнем сервисе</h3>
        <p>{request.message}</p>
        <div className="button-row">
          <button
            className="primary"
            disabled={!request.url}
            onClick={() => request.url && void Browser.open({ url: request.url })}
          >
            Открыть в браузере
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => void respond({ kind: "elicitation", action: "decline", content: null })}
          >
            Отказать
          </button>
          <button
            disabled={busy}
            onClick={() => void respond({ kind: "elicitation", action: "cancel", content: null })}
          >
            Отменить
          </button>
        </div>
      </>
    );
  }
  function submitForm() {
    const message = request.schema ? validateElicitation(request.schema, content) : null;
    if (message) {
      setValidationError(message);
      return;
    }
    void respond({ kind: "elicitation", action: "accept", content });
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitForm();
      }}
    >
      <h3>Форма инструмента</h3>
      <p>{request.message}</p>
      {request.schema &&
        Object.entries(request.schema.properties).map(([name, schema]) => (
          <ElicitationField
            key={name}
            name={name}
            schema={schema}
            required={request.schema!.required.includes(name)}
            value={content[name]}
            onChange={(value) => setContent({ ...content, [name]: value })}
          />
        ))}
      {validationError && <div className="error-banner">{validationError}</div>}
      <div className="button-row">
        <button className="primary" disabled={busy}>
          Отправить
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => void respond({ kind: "elicitation", action: "decline", content: null })}
        >
          Отказать
        </button>
      </div>
    </form>
  );
}

function ElicitationField({
  name,
  schema,
  required,
  value,
  onChange,
}: {
  name: string;
  schema: ElicitationPrimitive;
  required: boolean;
  value: unknown;
  onChange(value: unknown): void;
}) {
  const label = schema.title ?? name;
  if (schema.type === "boolean") {
    return (
      <label className="check">
        <input
          type="checkbox"
          checked={Boolean(value ?? schema.default)}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
    );
  }
  if (schema.type === "array") {
    return (
      <fieldset>
        <legend>{label}</legend>
        {schema.items.enum?.map((option) => (
          <label className="check" key={option}>
            <input
              type="checkbox"
              checked={Array.isArray(value) && value.includes(option)}
              onChange={(event) => {
                const current = Array.isArray(value) ? value : [];
                onChange(
                  event.target.checked
                    ? [...current, option]
                    : current.filter((item) => item !== option),
                );
              }}
            />
            {option}
          </label>
        ))}
      </fieldset>
    );
  }
  if (schema.type === "string" && schema.enum) {
    return (
      <label>
        {label}
        <select
          required={required}
          value={String(value ?? schema.default ?? "")}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Выберите</option>
          {schema.enum.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label>
      {label}
      <input
        type={
          schema.type === "string" ? (schema.format === "password" ? "password" : "text") : "number"
        }
        required={required}
        min={"minimum" in schema ? schema.minimum : undefined}
        max={"maximum" in schema ? schema.maximum : undefined}
        minLength={"minLength" in schema ? schema.minLength : undefined}
        maxLength={"maxLength" in schema ? schema.maxLength : undefined}
        value={String(value ?? schema.default ?? "")}
        onChange={(event) =>
          onChange(schema.type === "string" ? event.target.value : Number(event.target.value))
        }
      />
    </label>
  );
}

function validateElicitation(
  schema: NonNullable<Extract<AttentionRequest, { kind: "elicitation" }>["schema"]>,
  content: Record<string, unknown>,
): string | null {
  for (const name of schema.required) {
    const field = schema.properties[name];
    const value = content[name] ?? (field ? elicitationDefault(field) : undefined);
    if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
      return `Заполните обязательное поле «${schema.properties[name]?.title ?? name}»`;
    }
  }
  for (const [name, field] of Object.entries(schema.properties)) {
    const value = content[name] ?? elicitationDefault(field);
    if (field.type === "array" && Array.isArray(value)) {
      if (field.minItems !== undefined && value.length < field.minItems)
        return `Выберите больше значений в поле «${field.title ?? name}»`;
      if (field.maxItems !== undefined && value.length > field.maxItems)
        return `Выберите меньше значений в поле «${field.title ?? name}»`;
    }
  }
  return null;
}

function elicitationDefault(field: ElicitationPrimitive): unknown {
  return "default" in field ? field.default : undefined;
}
