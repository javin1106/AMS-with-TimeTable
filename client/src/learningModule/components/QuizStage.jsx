import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, Button, Flex, HStack, Heading, Text } from '@chakra-ui/react';
import { getQuizStageHost, openQuizStage, requestQuizFullscreen } from '../quizStage';

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
      <Flex
        align="center"
        gap={3}
        px={{ base: 3, md: 6 }}
        py={3}
        bg="white"
        borderBottomWidth="1px"
        borderColor="gray.200"
        wrap="wrap"
      >
        <HStack spacing={2} flexShrink={0}>
          <Text fontSize="xl" aria-hidden="true">
            🎓
          </Text>
          <Box>
            <Heading size="sm" color="gray.800" lineHeight="1.1">
              XCEED Learning
            </Heading>
            <Text fontSize="xs" color="gray.500">
              Assessment
            </Text>
          </Box>
        </HStack>

        {/* Identity never shrinks: it is the part of the bar a proctor and an
            invigilated student both check, so the paper's title is what gives
            way on a narrow screen, not whose subject this is. */}
        {(subject || faculty) && (
          <>
            <Box w="1px" alignSelf="stretch" bg="gray.200" display={{ base: 'none', sm: 'block' }} />
            <Box flexShrink={0}>
              {subject && (
                <Text fontSize="sm" fontWeight="600" color="gray.800">
                  {subject}
                </Text>
              )}
              {faculty && (
                <Text fontSize="xs" color="gray.500">
                  👤 {faculty}
                </Text>
              )}
            </Box>
          </>
        )}

        <Box flex="1" minW={0} />

        {/* The paper's own name, kept in the bar rather than only on the page:
            mid-test it has scrolled away, and "which test am I in" is a
            question worth never having to scroll back for. */}
        {title && (
          <Text
            fontSize="sm"
            fontWeight="600"
            color="gray.700"
            noOfLines={1}
            minW={0}
            maxW={{ base: '100%', md: '340px' }}
          >
            {title}
          </Text>
        )}

        {/* Only shown when the browser refused the automatic request, or the
            student pressed Escape — one press away from putting it back. */}
        {!isFullscreen && (
          <Button size="xs" variant="outline" onClick={enter} leftIcon={<span aria-hidden="true">⛶</span>}>
            Fullscreen
          </Button>
        )}
      </Flex>

      <Box maxW="960px" mx="auto" px={{ base: 3, md: 6 }} py={5}>
        {children}
      </Box>
    </Box>,
    host,
  );
}
