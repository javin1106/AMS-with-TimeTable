import React from 'react';
import { Navigate, Outlet, useOutletContext, useParams } from 'react-router-dom';

/**
 * Keeps students out of the staff screens.
 *
 * This is **not** the security boundary — every teacher-only endpoint is guarded
 * by `requireTeacher` on the server, and that is what actually protects the
 * data. Without this, a student who typed a staff URL got the full page chrome
 * and then a bare 403 where the content should be, which reads as the app being
 * broken rather than as a door that was never theirs.
 *
 * `isTeacher` comes from ClassLayout's context, which has already resolved the
 * class before any child renders — so there is no flash of staff UI while a
 * permission check is in flight.
 */
export default function RequireTeacher() {
  const context = useOutletContext();
  const { classId } = useParams();

  if (!context?.isTeacher) {
    return <Navigate to={`/learning/class/${classId}`} replace />;
  }

  return <Outlet context={context} />;
}
