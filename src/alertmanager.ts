import { z } from "zod";

const singleAlertSchema = z.object({
  status: z.string().optional(),
  labels: z.record(z.string()).default({}),
  annotations: z.record(z.string()).default({}),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  generatorURL: z.string().optional()
});

export const alertmanagerPayloadSchema = z
  .object({
    receiver: z.string().optional(),
    status: z.string().optional(),
    alerts: z.array(singleAlertSchema).default([]),
    commonLabels: z.record(z.string()).default({}),
    commonAnnotations: z.record(z.string()).default({}),
    externalURL: z.string().optional()
  })
  .passthrough();

type AlertPayload = z.infer<typeof alertmanagerPayloadSchema>;

function maybeLine(label: string, value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return `${label}: ${value}`;
}

export function formatAlertMessage(payload: AlertPayload): string {
  const lines: string[] = [];
  lines.push(`Alertmanager status=${payload.status ?? "unknown"}`);

  const receiverLine = maybeLine("receiver", payload.receiver);
  if (receiverLine) {
    lines.push(receiverLine);
  }

  const alertName =
    payload.commonLabels.alertname ||
    payload.alerts[0]?.labels.alertname ||
    payload.alerts[0]?.labels.instance;
  const severity =
    payload.commonLabels.severity || payload.alerts[0]?.labels.severity;

  const alertNameLine = maybeLine("alert", alertName);
  if (alertNameLine) {
    lines.push(alertNameLine);
  }

  const severityLine = maybeLine("severity", severity);
  if (severityLine) {
    lines.push(severityLine);
  }

  const summary =
    payload.commonAnnotations.summary ||
    payload.commonAnnotations.description ||
    payload.alerts[0]?.annotations.summary ||
    payload.alerts[0]?.annotations.description;
  const summaryLine = maybeLine("summary", summary);
  if (summaryLine) {
    lines.push(summaryLine);
  }

  for (const alert of payload.alerts.slice(0, 5)) {
    const line = [
      `[${alert.status ?? "unknown"}]`,
      alert.labels.alertname ?? alert.labels.instance ?? "alert",
      alert.annotations.summary ?? alert.annotations.description ?? ""
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`- ${line}`);
  }

  if (payload.externalURL) {
    lines.push(`source: ${payload.externalURL}`);
  }

  const rendered = lines.join("\n");
  return rendered.length > 3900 ? `${rendered.slice(0, 3900)}\n...truncated` : rendered;
}
