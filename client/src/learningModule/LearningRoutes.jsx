import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import LearningLayout from './components/LearningLayout';
import ClassLayout from './pages/ClassLayout';
import Dashboard from './pages/Dashboard';
import Stream from './pages/Stream';
import Classwork from './pages/Classwork';
import CourseworkDetail from './pages/CourseworkDetail';
import GradeWork from './pages/GradeWork';
import People from './pages/People';
import Grades from './pages/Grades';
import AiStudio from './pages/AiStudio';
import Insights from './pages/Insights';
import ClassSettings from './pages/ClassSettings';
import QuizPlayer from './pages/QuizPlayer';
import QuizEditor from './pages/QuizEditor';
import QuizResults from './pages/QuizResults';
import Todo from './pages/Todo';
import Calendar from './pages/Calendar';
import Notifications from './pages/Notifications';

/**
 * The whole learning module hangs off one route in App.jsx (`/learning/*`),
 * so adding a screen here never touches the app-wide router.
 */
export default function LearningRoutes() {
  return (
    <Routes>
      <Route element={<LearningLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="todo" element={<Todo />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="notifications" element={<Notifications />} />

        <Route path="class/:classId" element={<ClassLayout />}>
          <Route index element={<Stream />} />
          <Route path="classwork" element={<Classwork />} />
          <Route path="work/:courseworkId" element={<CourseworkDetail />} />
          <Route path="work/:courseworkId/grade" element={<GradeWork />} />
          <Route path="people" element={<People />} />
          <Route path="grades" element={<Grades />} />
          <Route path="studio" element={<AiStudio />} />
          <Route path="insights" element={<Insights />} />
          <Route path="settings" element={<ClassSettings />} />
          <Route path="quiz/:quizId" element={<QuizPlayer />} />
          <Route path="quiz/:quizId/edit" element={<QuizEditor />} />
          <Route path="quiz/:quizId/results" element={<QuizResults />} />
        </Route>

        <Route path="*" element={<Navigate to="/learning" replace />} />
      </Route>
    </Routes>
  );
}
