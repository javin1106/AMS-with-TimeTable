// client/src/attendancemodule/AMSLayout.jsx

import { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { theme } from './config';
import getEnvironment from '../getenvironment';
import { HealthProvider } from './HealthContext';
import ILeed from './BrandName';

const T = theme;
const apiUrl = getEnvironment();

// Small home glyph for the iLEED Home nav item (expanded + collapsed states).
function HomeIcon({ size = 14 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

const NAV = [
  // label is the plain-text fallback (tooltip, collapsed initial); the
  // expanded sidebar renders the styled iLEED wordmark instead.
  { id: 'dashboard', route: '/attendance', label: 'iLEED', exact: true },
  { id: 'rtsp', route: '/attendance/groundtruth/rtsp', label: 'Ground Truth Capture' },
  {
    id: 'assign',
    route: '/attendance/groundtruth/assign',
    label: 'Roll Assignment',
  },
  {
    id: 'upload',
    route: '/attendance/groundtruth/upload',
    label: 'ERP Upload',
  },
  { id: 'reports', route: '/attendance/reports', label: 'Attendance Reports' },
  {
    id: 'verify',
    route: '/attendance/frame-verification',
    label: 'Class Verification',
  },
  { id: 'cameras', route: '/cameras', label: 'Camera Registry', exact: true },
  { id: 'embeddings', route: '/attendance/embeddings', label: 'Subject Embeddings' },
  { id: 'preview', route: '/cameras/preview', label: 'Live Preview' },
  { id: 'record', route: '/attendance/record-stream', label: 'Record Stream' },
  { id: 'extraClass', route: '/attendance/extra-class', label: 'Extra Classes' },
  { id: 'alterClass', route: '/attendance/altering-class', label: 'Altering Classes' },
  {
    id: 'confidence',
    route: '/attendance/confidence',
    label: 'Confidence Monitor',
  },
  { id: 'institute', route: '/attendance/institute-identification', label: 'Institute Identification' },
  { id: 'erpOverrides', route: '/attendance/erp-overrides', label: 'ERP Overrides' },
  { id: 'manual', route: '/ams-manual', label: 'Help & Manual', newTab: true },
];

const COLORS = {
  dashboard: '#6366f1',
  rtsp: '#0ea5e9',
  assign: '#10b981',
  upload: '#f472b6',
  reports: '#14b8a6',
  verify: '#ec4899',
  cameras: '#f97316',
  embeddings: '#f59e0b',
  preview: '#8b5cf6',
  confidence: '#ef4444',
  record: '#ef4444',
  extraClass: '#f59e0b',
  alterClass: '#d946ef',
  manual: '#64748b',
  institute: '#8b5cf6',
  erpOverrides: '#f59e0b',
};

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap');
  * { box-sizing: border-box; }
  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-track { background: #f0f2f9; }
  ::-webkit-scrollbar-thumb { background: #d0d5ea; border-radius: 4px; }
  @keyframes amsFadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; } }
  .ams-nav-item { transition: background .15s, color .15s; cursor: pointer; }
  .ams-nav-item:hover { background: rgba(99,102,241,0.06) !important; }
  .ams-nav-newtab-btn { opacity: 0; transition: opacity .12s, background .12s, color .12s; }
  .ams-nav-item:hover .ams-nav-newtab-btn { opacity: 1; }
  .ams-nav-newtab-btn:hover { background: rgba(99,102,241,0.12) !important; color: #6366f1 !important; }
  .ams-page-content { /* no animation — CSS animation creates stacking context that traps fixed-position portals */ }
`;

export default function AMSLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accessChecked, setAccessChecked] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiUrl}/attendancemodule/dept-admin/context`, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.message || 'Attendance access denied');
        if (!data.fullAccess) {
          navigate('/dept-admin/dashboard', { replace: true });
          return;
        }
        setAccessChecked(true);
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          navigate('/userroles', { replace: true });
        }
      });
    return () => controller.abort();
  }, [navigate]);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    // If mobile status changes, make sure drawer starts as closed
    if (isMobile) setMobileOpen(false);
  }, [isMobile]);

  function isActive(item) {
    if (item.exact)
      return (
        location.pathname === item.route ||
        location.pathname === item.route + '/'
      );
    // Items that deep-link into a specific settings tab (e.g. "?tab=erpControls")
    // need the query string compared too, since pathname alone can't tell
    // them apart from the page's other tabs.
    if (item.route.includes('?')) {
      return location.pathname + location.search === item.route;
    }
    return location.pathname.startsWith(item.route);
  }

  const isSidebarCollapsed = isMobile ? false : collapsed;
  const SIDEBAR_W = isMobile ? 240 : (isSidebarCollapsed ? 52 : 208);

  if (!accessChecked) return null;

  return (
    <HealthProvider>
      <style>{CSS}</style>
      <div
        style={{
          display: 'flex',
          minHeight: '100vh',
          background: T.bg,
          color: T.text,
          fontFamily: T.fontBody,
        }}
      >
        {/* Sidebar Backdrop on Mobile */}
        {isMobile && mobileOpen && (
          <div
            onClick={() => setMobileOpen(false)}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(26,31,60,0.4)',
              backdropFilter: 'blur(2px)',
              zIndex: 9998,
            }}
          />
        )}

        {/* Sidebar */}
        <aside
          style={{
            width: SIDEBAR_W,
            flexShrink: 0,
            background: '#ffffff',
            borderRight: `1px solid ${T.border}`,
            display: 'flex',
            flexDirection: 'column',
            transition: 'width .22s ease, transform .22s ease',
            overflow: 'hidden',
            position: isMobile ? 'fixed' : 'sticky',
            top: 0,
            bottom: 0,
            left: 0,
            height: '100vh',
            zIndex: isMobile ? 9999 : 1000,
            boxShadow: '1px 0 8px rgba(26,31,60,0.05)',
            transform: isMobile && !mobileOpen ? 'translateX(-100%)' : 'none',
          }}
        >
          {/* Nav */}
          <nav style={{ flex: 1, overflowY: 'auto', padding: '12px 8px' }}>
            {NAV.map((item) => {
              const active = isActive(item);
              const color = COLORS[item.id] || T.accent;
              return (
                <div
                  key={item.id}
                  className="ams-nav-item"
                  onClick={() => {
                    if (item.newTab) {
                      window.open(item.route, '_blank', 'noopener,noreferrer');
                    } else {
                      navigate(item.route);
                      if (isMobile) setMobileOpen(false);
                    }
                  }}
                  title={isSidebarCollapsed ? item.label : undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: isSidebarCollapsed ? 'center' : 'flex-start',
                    gap: 9,
                    padding: isSidebarCollapsed ? '10px 0' : '9px 11px',
                    borderRadius: 8,
                    marginBottom: 2,
                    background: active ? `${color}12` : 'transparent',
                    border: `1px solid ${active ? color + '28' : 'transparent'}`,
                    color: active ? color : T.textMuted,
                    position: 'relative',
                  }}
                >
                  {active && (
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: '22%',
                        bottom: '22%',
                        width: 3,
                        borderRadius: '0 3px 3px 0',
                        background: color,
                      }}
                    />
                  )}
                  {isSidebarCollapsed ? (
                    item.id === 'dashboard' ? (
                      <HomeIcon />
                    ) : (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 800,
                          fontFamily: "'IBM Plex Mono', monospace",
                          color: active ? color : T.textMuted,
                        }}
                      >
                        {item.label[0]}
                      </span>
                    )
                  ) : (
                    <span
                      style={{
                        fontSize: 12.5,
                        fontWeight: active ? 600 : 400,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        flex: 1,
                      }}
                    >
                      {item.id === 'dashboard'
                        ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, verticalAlign: 'middle' }}>
                            <HomeIcon />
                            <ILeed style={{ lineHeight: 1, display: 'inline-block', fontSize: 16 }} />
                          </span>
                        )
                        : item.label}
                    </span>
                  )}
                  {!isSidebarCollapsed && !item.newTab && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        window.open(item.route, '_blank', 'noopener,noreferrer');
                      }}
                      title={`Open ${item.label} in new tab`}
                      className="ams-nav-newtab-btn"
                      style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        right: 4,
                        width: 26,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        color: T.textMuted,
                        fontSize: 18,
                        fontWeight: 600,
                        lineHeight: 1,
                        borderRadius: 6,
                      }}
                    >
                      +
                    </button>
                  )}
                </div>
              );
            })}
          </nav>

          {/* Collapse toggle */}
          {!isMobile && (
            <div
              style={{
                padding: '10px 8px',
                borderTop: `1px solid ${T.border}`,
                flexShrink: 0,
              }}
            >
              <div
                className="ams-nav-item"
                onClick={() => setCollapsed((c) => !c)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: isSidebarCollapsed ? 'center' : 'flex-start',
                  gap: 8,
                  padding: isSidebarCollapsed ? '8px 0' : '8px 11px',
                  borderRadius: 7,
                  color: T.textMuted,
                  fontSize: 11,
                  fontWeight: 500,
                }}
              >
                <span
                  style={{
                    display: 'inline-block',
                    transform: isSidebarCollapsed ? 'rotate(180deg)' : 'none',
                    transition: 'transform .2s',
                    fontSize: 13,
                    lineHeight: 1,
                  }}
                >
                  ‹
                </span>
                {!isSidebarCollapsed && 'Collapse'}
              </div>
            </div>
          )}
        </aside>

        {/* Main content wrapper */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: '100vh' }}>
          {isMobile && (
            <header
              style={{
                height: 52,
                background: '#ffffff',
                borderBottom: `1px solid ${T.border}`,
                display: 'flex',
                alignItems: 'center',
                padding: '0 16px',
                position: 'sticky',
                top: 0,
                zIndex: 90,
                boxShadow: '0 1px 4px rgba(26,31,60,0.05)',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button
                  onClick={() => setMobileOpen(true)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 4,
                    color: T.text,
                  }}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="3" y1="12" x2="21" y2="12" />
                    <line x1="3" y1="6" x2="21" y2="6" />
                    <line x1="3" y1="18" x2="21" y2="18" />
                  </svg>
                </button>
                <span style={{ fontWeight: 700, fontSize: 16 }}>
                  <ILeed style={{ lineHeight: 1, display: 'inline-block', fontSize: 16 }} />
                </span>
              </div>
              <div style={{ fontSize: 11, color: T.textMuted, fontWeight: 500 }}>
                Attendance System
              </div>
            </header>
          )}

          {/* Main content */}
          <main
            className="ams-page-content"
            style={{ flex: 1, minWidth: 0, overflow: 'auto' }}
          >
            <Outlet />
          </main>
        </div>
      </div>
    </HealthProvider>
  );
}