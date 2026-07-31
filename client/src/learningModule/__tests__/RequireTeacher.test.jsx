import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';

import RequireTeacher from '../components/RequireTeacher';

/**
 * The staff-screen gate.
 *
 * Not the security boundary — the server's `requireTeacher` is — but the thing
 * that decides whether a student who typed a staff URL gets sent home or is
 * left staring at a broken-looking page.
 */

// Stands in for ClassLayout: resolves the class, then renders children with the
// role in context.
function ClassShell({ isTeacher }) {
  return <Outlet context={{ classId: 'c1', isTeacher }} />;
}

const renderAt = (path, isTeacher) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/learning/class/:classId" element={<ClassShell isTeacher={isTeacher} />}>
          <Route index element={<div>stream</div>} />
          <Route element={<RequireTeacher />}>
            <Route path="settings" element={<div>staff settings</div>} />
          </Route>
        </Route>
      </Routes>
    </MemoryRouter>,
  );

describe('learningModule <RequireTeacher />', () => {
  it('renders the staff screen for a teacher', () => {
    renderAt('/learning/class/c1/settings', true);
    expect(screen.getByText('staff settings')).toBeInTheDocument();
  });

  it('sends a student to the class stream instead', () => {
    renderAt('/learning/class/c1/settings', false);
    expect(screen.queryByText('staff settings')).not.toBeInTheDocument();
    expect(screen.getByText('stream')).toBeInTheDocument();
  });

  it('never renders the staff screen even for an instant', () => {
    // The redirect has to be decided from context that is already resolved. If
    // it waited on a fetch, a student would see the staff page flash first —
    // and on a results screen that flash is the leak.
    const { container } = renderAt('/learning/class/c1/settings', false);
    expect(container.innerHTML).not.toContain('staff settings');
  });

  it('treats a missing role as not-a-teacher', () => {
    // Defaulting the other way would open every staff screen on any context
    // shape this component did not anticipate.
    render(
      <MemoryRouter initialEntries={['/learning/class/c1/settings']}>
        <Routes>
          <Route path="/learning/class/:classId" element={<Outlet context={undefined} />}>
            <Route index element={<div>stream</div>} />
            <Route element={<RequireTeacher />}>
              <Route path="settings" element={<div>staff settings</div>} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText('staff settings')).not.toBeInTheDocument();
  });
});
