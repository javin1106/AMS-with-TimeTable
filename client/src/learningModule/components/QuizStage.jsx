import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, Button } from '@chakra-ui/react';
import { getQuizStageHost, openQuizStage, requestQuizFullscreen } from '../quizStage';
import StageBar from './StageBar';

/**
 * The canvas a quiz runs on — the brief and the sitting alike.
 *
 * Both screens render into one host element that outlives either of them, so
 * fullscreen taken on the instructions carries straight through into the paper
 * (see `../quizStage` for why that has to live outside the route tree). The
 * stage carries the only chrome a test is allowed: which paper this is, for
 * which subject, set by whom.
 */
export default function QuizStage({ subject, faculty, title, children }) {
  const [host] = useState(getQuizStageHost);
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(document.fullscreenElement));

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => openQuizStage(), []);

  const enter = useCallback(() => {
    requestQuizFullscreen();
  }, []);

  return createPortal(
    <Box minH="100%">
      <StageBar
        subject={subject}
        faculty={faculty}
        title={title}
        action={
          /* Only shown when the browser refused the automatic request, or the
             student pressed Escape — one press away from putting it back. */
          !isFullscreen && (
            <Button size="xs" variant="outline" onClick={enter} leftIcon={<span aria-hidden="true">⛶</span>}>
              Fullscreen
            </Button>
          )
        }
      />

      <Box maxW="960px" mx="auto" px={{ base: 3, md: 6 }} py={5}>
        {children}
      </Box>
    </Box>,
    host,
  );
}
