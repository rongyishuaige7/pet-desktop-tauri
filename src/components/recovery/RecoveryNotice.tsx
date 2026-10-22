import React, { useState } from "react";

export interface RecoveryAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

interface RecoveryNoticeProps {
  title: string;
  body: string;
  operation?: string;
  code?: string;
  actions: RecoveryAction[];
  onDismiss?: () => void;
}

/**
 * Persistent recovery entry. Dismissing hides the panel but the header keeps a
 * "需要帮助" button so the recovery path cannot be lost.
 */
export const RecoveryNotice: React.FC<RecoveryNoticeProps> = ({
  title,
  body,
  operation,
  code,
  actions,
  onDismiss
}) => {
  const [copied, setCopied] = useState(false);

  async function copyDetails() {
    const text = [operation && `operation: ${operation}`, code && `code: ${code}`]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section
      className="recovery-notice"
      role="alert"
      aria-labelledby="recovery-title"
      tabIndex={-1}
    >
      <div className="recovery-head">
        <div>
          <strong id="recovery-title">{title}</strong>
          <p>{body}</p>
        </div>
        {onDismiss && (
          <button
            type="button"
            className="recovery-dismiss"
            onClick={onDismiss}
            aria-label="关闭这条提示"
          >
            ×
          </button>
        )}
      </div>

      <div className="recovery-actions">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={action.primary ? "btn-primary" : "btn-secondary"}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </div>

      {(operation || code) && (
        <details className="recovery-details">
          <summary>查看详情</summary>
          <div className="recovery-code-row">
            <code>
              {operation ? `${operation} / ` : ""}
              {code ?? "UNKNOWN"}
            </code>
            <button type="button" className="btn-secondary" onClick={copyDetails}>
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          <p>详情只包含阶段与脱敏错误码，不包含照片、密钥或服务地址。</p>
        </details>
      )}
    </section>
  );
};
