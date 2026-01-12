export const focusAlertTemplate = ({
  studentName,
  className,
  occurredAt,
  reason,
  details,
  screenshotUrl,
}) => {
  const reasonMap = {
    tab_blur: "switched away from the class tab",
    window_minimized: "minimized the window",
    app_switched: "switched applications",
    network_lost: "lost network connection",
    other: "left focus",
  };
  const readableReason = reasonMap[reason] || reasonMap.other;

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:#222;">
    <h2 style="margin:0 0 8px;color:#7b2a30">Parent Focus Alert</h2>
    <p><strong>${studentName}</strong> ${readableReason} during <strong>${className}</strong>.</p>
    <p><strong>Time:</strong> ${new Date(occurredAt).toLocaleString()}</p>
    ${details ? `<p><strong>Details:</strong> ${details}</p>` : ""}
    ${
      screenshotUrl
        ? `<p><a href="${screenshotUrl}" target="_blank">View screenshot</a></p>`
        : ""
    }
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
    <p style="font-size:12px;color:#666;">This alert is automatic. If this is unexpected, please contact the class teacher.</p>
  </div>
  `;
};
