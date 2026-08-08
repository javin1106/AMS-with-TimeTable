import React from "react";
import { cssReset } from "./config";

// USE to display Proxy student information from attendanceReport.js ' s proxyStudentSchema

export default function ProxyModal({
  open,
  onClose,
  proxyStudents = [],
  theme,
  styles,
}) {
  if (!open) return null;

  const CSS = `
    ${cssReset}
    .proxy-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .proxy-table { width: 100%; min-width: 520px; border-collapse: collapse; }
    .proxy-table th, .proxy-table td { border: 0; border-bottom: 1px solid ${theme.border}; }
    @media (max-width: 600px) {
      .proxy-overlay { padding: 8px !important; align-items: flex-start !important; }
      .proxy-shell { max-height: calc(100dvh - 16px) !important; }
      .proxy-header, .proxy-body, .proxy-footer { padding: 14px !important; }
      .proxy-header { align-items: flex-start !important; }
      .proxy-student-header { align-items: flex-start !important; gap: 10px; flex-wrap: wrap; }
      .proxy-footer button { width: 100%; }
    }
  `;

  return (
    <>
    <style>
      {CSS}
    </style>
    <div
      className="proxy-overlay"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.55)",
        backdropFilter: "blur(4px)",
        zIndex: 9999,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: 24,
      }}
    >
      <div
        className="proxy-shell"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 850,
          maxHeight: "85vh",
          overflowY: "auto",
          background: theme.surface,
          borderRadius: 14,
          border: `1px solid ${theme.border}`,
          boxShadow: "0 20px 60px rgba(0,0,0,.25)",
        }}
      >
        {/* Header */}
        <div
          className="proxy-header"
          style={{
            padding: "18px 22px",
            borderBottom: `1px solid ${theme.border}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                color: theme.text,
              }}
            >
              Possible Proxy Attendance
            </div>

            <div
              style={{
                marginTop: 4,
                color: theme.textMuted,
                fontSize: 13,
              }}
            >
              Students detected in more than one classroom during the same
              timeslot.
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: 24,
              color: theme.textMuted,
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="proxy-body" style={{ padding: 22 }}>
          {proxyStudents.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                color: theme.textMuted,
                padding: "40px 0",
              }}
            >
              No proxy attendance detected.
            </div>
          ) : (
            proxyStudents.map((student) => (
              <div
                key={student.rollNo}
                style={{
                  marginBottom: 22,
                  border: `1px solid ${theme.border}`,
                  borderRadius: 10,
                  overflow: "hidden",
                }}
              >
                {/* Student Header */}
                <div
                  className="proxy-student-header"
                  style={{
                    background: theme.warningDim,
                    padding: "12px 18px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        color: theme.textMuted,
                        textTransform: "uppercase",
                      }}
                    >
                      Roll Number
                    </div>

                    <div
                      style={{
                        fontFamily: theme.fontMono,
                        fontWeight: 700,
                        fontSize: 18,
                        color: theme.text,
                      }}
                    >
                      {student.rollNo}
                    </div>
                  </div>

                  <span
                    style={{
                      ...styles.badge("warning"),
                      fontSize: 12,
                    }}
                  >
                    Detected in {student.otherReports.length} oher class 
                    {student.otherReports.length > 1 ? "es" : ""}
                  </span>
                </div>

                {/* Reports */}
                <div className="proxy-table-wrap" style={{ padding: 18 }}>
                  <table className="proxy-table">
                    <thead>
                      <tr>
                        <th style={thStyle(theme)}>Room</th>
                        <th style={thStyle(theme)}>Subject</th>
                        <th style={thStyle(theme)}>Faculty</th>
                      </tr>
                    </thead>

                    <tbody>
                      {student.otherReports.map((r) => (
                        <tr key={r.reportId}>
                          <td style={tdStyle(theme)}>
                            <span
                              style={{
                                fontFamily: theme.fontMono,
                                fontWeight: 600,
                              }}
                            >
                              {r.room}
                            </span>
                          </td>

                          <td style={tdStyle(theme)}>
                            {r.subject || "—"}
                          </td>

                          <td style={tdStyle(theme)}>
                            {r.faculty || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div
          className="proxy-footer"
          style={{
            padding: 18,
            borderTop: `1px solid ${theme.border}`,
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button
            onClick={onClose}
            style={styles.btnPrimary}
          >
            Close
          </button>
        </div>
      </div>
    </div>
    </>
  );
}

function thStyle(theme) {
  return {
    textAlign: "left",
    padding: "10px 12px",
    fontSize: 12,
    color: theme.textMuted,
    borderBottom: `1px solid ${theme.border}`,
    fontWeight: 600,
  };
}

function tdStyle(theme) {
  return {
    padding: "12px",
    borderBottom: `1px solid ${theme.border}`,
    color: theme.text,
    fontSize: 13,
  };
}
