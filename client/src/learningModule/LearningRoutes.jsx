import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import LearningLayout from './components/LearningLayout';
import RequireTeacher from './components/RequireTeacher';
import ClassLayout from './pages/ClassLayout';
import Dashboard from './pages/Dashboard';
import Stream from './pages/Stream';
import Material from './pages/Material';
import CourseworkDetail from './pages/CourseworkDetail';
import GradeWork from './pages/GradeWork';
import People from './pages/People';
import Grades from './pages/Grades';
import Leaderboard from './pages/Leaderboard';
import PointsGuide from './pages/PointsGuide';
import Discussions from './pages/Discussions';
import Feedback from './pages/Feedback';
import AiStudio from './pages/AiStudio';
import AiPlayground from './pages/AiPlayground';
import Insights from './pages/Insights';
import ClassSettings from './pages/ClassSettings';
import Quizzes from './pages/Quizzes';
import QuizBrief from './pages/QuizBrief';
import QuizAttempt from './pages/QuizAttempt';
import QuizEditor from './pages/QuizEditor';
import QuizResults from './pages/QuizResults';
import Notebooks from './pages/Notebooks';
import NotebookEditor from './pages/NotebookEditor';
import NotebookPlayer from './pages/NotebookPlayer';
import NotebookSubmissions from './pages/NotebookSubmissions';
import Shorts from './pages/Shorts';
import ShortEditor from './pages/ShortEditor';
import ShortPresent from './pages/ShortPresent';
import ShortSessions from './pages/ShortSessions';
import ShortReport from './pages/ShortReport';
import ShortJoin from './pages/ShortJoin';
import ShortPlay from './pages/ShortPlay';
import Tutorials from './pages/Tutorials';
import TutorialEditor from './pages/TutorialEditor';
import TutorialPlayer from './pages/TutorialPlayer';
import TutorialResults from './pages/TutorialResults';
import Todo from './pages/Todo';
import Calendar from './pages/Calendar';
import Notifications from './pages/Notifications';
import Profile from './pages/Profile';
import BugReports from './pages/BugReports';
import LmAdmin from './pages/LmAdmin';

/**
 * The whole learning module hangs off one route in App.jsx (`/learning/*`),
 * so adding a screen here never touches the app-wide router.
 */
export default function LearningRoutes() {
  return (
    <Routes>
      {/* Joining and answering a Short sit outside class/:classId — someone who
          scanned the QR at the front of the room has a code, not a class — and
          outside LearningLayout, whose bootstrap fetches the signed-in user and
          would bounce a guest to the login page. A deck with `requireLogin` off
          admits people with no account at all, so these two screens have to
          stand on their own. */}
      <Route path="short/join" element={<ShortJoin />} />
      <Route path="short/join/:code" element={<ShortJoin />} />
      <Route path="short/live/:sessionId" element={<ShortPlay />} />

      <Route element={<LearningLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="todo" element={<Todo />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="profile" element={<Profile />} />
        <Route path="bugs" element={<BugReports />} />
        <Route path="lm-admin" element={<LmAdmin />} />

        <Route path="class/:classId" element={<ClassLayout />}>
          <Route index element={<Stream />} />
          <Route path="material" element={<Material />} />
          {/* Classwork was split across Material, Quizzes, Shorts and Tutorials;
              old links land on the tab that inherited its reading material. */}
          <Route path="classwork" element={<Navigate to="../material" replace />} />
          <Route path="work/:courseworkId" element={<CourseworkDetail />} />
          <Route path="people" element={<People />} />
          <Route path="grades" element={<Grades />} />
          <Route path="leaderboard" element={<Leaderboard />} />
          <Route path="points" element={<PointsGuide />} />
          <Route path="discussions" element={<Discussions />} />
          <Route path="discussions/:discussionId" element={<Discussions />} />
          {/* Not behind RequireTeacher: the same screen serves the student who
              writes and the staff who read, and the server decides which. */}
          <Route path="feedback" element={<Feedback />} />
          <Route path="studio" element={<AiStudio />} />
          <Route path="playground" element={<AiPlayground />} />
          <Route path="quizzes" element={<Quizzes />} />
          <Route path="quiz/:quizId" element={<QuizBrief />} />
          <Route path="quiz/:quizId/attempt/:attemptId" element={<QuizAttempt />} />
          <Route path="notebooks" element={<Notebooks />} />
          <Route path="notebook/:notebookId" element={<NotebookPlayer />} />
          <Route path="shorts" element={<Shorts />} />
          <Route path="tutorials" element={<Tutorials />} />

          {/* Staff screens. The server guards the data; this keeps a student
              who typed the URL from meeting a bare 403 where a page should be. */}
          <Route element={<RequireTeacher />}>
            <Route path="work/:courseworkId/grade" element={<GradeWork />} />
            <Route path="insights" element={<Insights />} />
            <Route path="settings" element={<ClassSettings />} />
            <Route path="quiz/:quizId/edit" element={<QuizEditor />} />
            <Route path="quiz/:quizId/results" element={<QuizResults />} />
            <Route path="notebook/:notebookId/edit" element={<NotebookEditor />} />
            <Route path="notebook/:notebookId/submissions" element={<NotebookSubmissions />} />
            <Route path="short/:shortId/edit" element={<ShortEditor />} />
            <Route path="short/:shortId/present/:sessionId" element={<ShortPresent />} />
            <Route path="short/:shortId/sessions" element={<ShortSessions />} />
            <Route path="short/:shortId/report/:sessionId" element={<ShortReport />} />
            <Route path="tutorial/:tutorialId/edit" element={<TutorialEditor />} />
            <Route path="tutorial/:tutorialId/results" element={<TutorialResults />} />
          </Route>

          <Route path="tutorial/:tutorialId" element={<TutorialPlayer />} />
        </Route>

        <Route path="*" element={<Navigate to="/learning" replace />} />
      </Route>
    </Routes>
  );
}
