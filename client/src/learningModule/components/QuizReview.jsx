import React from 'react';
import { Badge, Box, Flex, HStack, Stack, Text } from '@chakra-ui/react';
import RichText from './RichText';
import { SectionCard } from './common';

/**
 * Per-question review after submitting.
 *
 * Option indices arrive already remapped into the order this student saw, so a
 * shuffled paper highlights the right row. Shared between the live player (just
 * after submitting), the attempt-history view, and staff reading one student's
 * paper on the results page — which is why the one second-person phrase here
 * takes `answerLabel`: "Your answer" is wrong when a teacher is reading it.
 */
export default function QuizReview({ review, title = 'Question review', answerLabel = 'Your answer' }) {
  if (!review?.length) return null;

  return (
    <SectionCard title={title}>
      {review.map((entry, index) => {
        const answer = entry.yourAnswer;
        const state = !answer?.attempted ? 'skipped' : answer.correct ? 'correct' : 'wrong';
        const accent = state === 'correct' ? 'green.400' : state === 'wrong' ? 'red.400' : 'gray.300';

        return (
          <Box
            key={entry.questionId || index}
            borderWidth="1px"
            borderLeftWidth="4px"
            borderLeftColor={accent}
            borderColor="gray.200"
            borderRadius="md"
            p={4}
            mb={3}
          >
            <Flex justify="space-between" gap={3} mb={2}>
              <Box flex="1" minW={0}>
                <HStack mb={1}>
                  <Text fontSize="sm" fontWeight="600">
                    Q{index + 1}.
                  </Text>
                  {entry.sectionName && (
                    <Badge colorScheme="purple" fontSize="0.6rem">
                      {entry.sectionName}
                    </Badge>
                  )}
                  {answer?.autoSubmitted && (
                    <Badge colorScheme="orange" fontSize="0.6rem">
                      auto-submitted
                    </Badge>
                  )}
                </HStack>
                <RichText>{entry.question}</RichText>
              </Box>
              <Box textAlign="right" flexShrink={0}>
                <Badge colorScheme={state === 'correct' ? 'green' : state === 'wrong' ? 'red' : 'gray'}>
                  {state === 'correct' ? 'Correct' : state === 'wrong' ? 'Incorrect' : 'Not answered'}
                </Badge>
                <Text fontSize="sm" fontWeight="700" mt={1}>
                  {answer?.awarded ?? 0}/{entry.marks}
                </Text>
                {entry.timeSpentSec > 0 && (
                  <Text fontSize="xs" color="gray.500">
                    {entry.timeSpentSec}s
                  </Text>
                )}
              </Box>
            </Flex>

            {entry.options?.length > 0 && (
              <Stack mt={2} spacing={1}>
                {entry.options.map((option, optionIndex) => {
                  const isCorrect = (entry.correctAnswers || []).map(String).includes(String(optionIndex));
                  const chose = (answer?.selected || []).map(String).includes(String(optionIndex));
                  return (
                    <Flex
                      key={optionIndex}
                      gap={2}
                      px={2}
                      py={1}
                      borderRadius="sm"
                      bg={isCorrect ? 'green.50' : chose ? 'red.50' : 'transparent'}
                    >
                      <Text fontSize="sm" flexShrink={0} w="16px">
                        {isCorrect ? '✓' : chose ? '✗' : ' '}
                      </Text>
                      <RichText color={isCorrect ? 'green.800' : chose ? 'red.800' : 'gray.700'}>
                        {option}
                      </RichText>
                    </Flex>
                  );
                })}
              </Stack>
            )}

            {entry.type === 'numerical' && (
              <Text fontSize="sm" mt={2} color="gray.600">
                {answerLabel}: <b>{answer?.text || '—'}</b> · Expected:{' '}
                <b>{(entry.correctAnswers || []).join(', ')}</b>
              </Text>
            )}

            {entry.explanation && (
              <Box mt={2} bg="blue.50" borderRadius="md" px={3} py={2}>
                <RichText>{entry.explanation}</RichText>
              </Box>
            )}

            {entry.sourceExcerpt && (
              <Text fontSize="xs" color="gray.500" mt={2} fontStyle="italic">
                From the lecture: “{entry.sourceExcerpt}”
              </Text>
            )}
          </Box>
        );
      })}
    </SectionCard>
  );
}
