import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useOutletContext, useParams } from 'react-router-dom';
import {
  Accordion,
  AccordionButton,
  AccordionIcon,
  AccordionItem,
  AccordionPanel,
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  SimpleGrid,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  VStack,
} from '@chakra-ui/react';

import lmApi from '../api/lmApi';
import { ErrorState, Loading, SectionCard, StatTile, buttonTextStyles } from '../components/common';
import { formatDateTime } from '../format';
import { richTextToPlain } from '../richTextUtils';
import ShortResults from '../components/ShortResults';

/**
 * What happened in one session.
 *
 * Two things a teacher actually wants afterwards: which slide the room got wrong,
 * and who was not answering. Both are surfaced above the per-slide detail rather
 * than buried under it.
 */
export default function ShortReport() {
  const { classId } = useOutletContext();
  const { shortId, sessionId } = useParams();

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setReport(await lmApi.shortSessionReport(classId, sessionId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading label="Loading report…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  const { short, session, slides, summary, leaderboard, maxScore, hasGradableSlides } = report;

  // Slides the room struggled with. 60% is a working threshold, not a rule — it
  // is there to give the teacher a shortlist rather than a verdict.
  const weakest = slides
    .filter((slide) => slide.gradable && slide.responses > 0 && slide.correctPercent < 60)
    .sort((a, b) => a.correctPercent - b.correctPercent);

  const quiet = leaderboard.filter((entry) => entry.answered === 0);

  return (
    <VStack align="stretch" spacing={5}>
      <Flex gap={3} wrap="wrap" align="flex-start">
        <Box flex="1" minW="220px">
          <Heading size="md">{short.title}</Heading>
          <Text fontSize="sm" opacity={0.7}>
            {formatDateTime(session.startedAt)}
            {session.presentedByName ? ` · ${session.presentedByName}` : ''}
            {session.status === 'live' ? ' · still live' : ''}
          </Text>
        </Box>
        <HStack spacing={2} wrap="wrap">
          <Button as={RouterLink} to={`/learning/class/${classId}/short/${shortId}/sessions`} size="sm" variant="ghost">
            All sessions
          </Button>
          <Button as="a" href={lmApi.shortSessionCsvUrl(classId, sessionId)} size="sm" variant="outline">
            Download CSV
          </Button>
        </HStack>
      </Flex>

      <SimpleGrid columns={{ base: 2, md: 4 }} spacing={4}>
        <StatTile label="Joined" value={summary.participants} accent="purple.500" />
        <StatTile label="Answers" value={summary.totalResponses} accent="blue.500" />
        <StatTile
          label="Slides used"
          value={`${summary.slidesPresented}/${slides.length}`}
          accent="teal.500"
        />
        <StatTile
          label="Avg per slide"
          value={summary.averageParticipation}
          hint="answers per slide"
          accent="orange.500"
        />
      </SimpleGrid>

      {weakest.length > 0 && (
        <SectionCard title="Worth going over again" subtitle="Under 60% correct in the room">
          <VStack align="stretch" spacing={2}>
            {weakest.map((slide) => (
              <Flex key={slide.slideId} gap={3} align="baseline">
                <Badge colorScheme="red">{slide.correctPercent}%</Badge>
                <Text fontSize="sm" flex="1" noOfLines={2}>
                  {richTextToPlain(slide.question)}
                </Text>
                <Text fontSize="xs" opacity={0.6} whiteSpace="nowrap">
                  slide {slide.index + 1}
                </Text>
              </Flex>
            ))}
          </VStack>
        </SectionCard>
      )}

      {quiet.length > 0 && (
        <SectionCard title="Joined but never answered" subtitle={`${quiet.length} of ${summary.participants}`}>
          <Text fontSize="sm">
            {quiet.map((entry) => entry.name || entry.email).join(', ')}
          </Text>
        </SectionCard>
      )}

      <SectionCard
        title={hasGradableSlides ? 'Leaderboard' : 'Participation'}
        subtitle={
          hasGradableSlides
            ? `Out of ${maxScore} · ties broken by how much was attempted, then by speed`
            : 'This deck has no marked slides, so there is no score'
        }
      >
        <Box overflowX="auto">
          <Table size="sm">
            <Thead>
              <Tr>
                <Th>#</Th>
                <Th>Name</Th>
                <Th>Roll no</Th>
                <Th isNumeric>Answered</Th>
                {hasGradableSlides && <Th isNumeric>Correct</Th>}
                {hasGradableSlides && <Th isNumeric>Score</Th>}
              </Tr>
            </Thead>
            <Tbody>
              {leaderboard.map((entry, index) => (
                <Tr key={String(entry.userId) + index} opacity={entry.answered ? 1 : 0.5}>
                  <Td>{index + 1}</Td>
                  <Td>
                    {entry.name || entry.email || '—'}
                    {/* Without this a guest reads as a student whose roll
                        number and email happen to be missing. */}
                    {entry.isGuest ? (
                      <Badge ml={2} colorScheme="orange" fontSize="0.65rem">
                        guest
                      </Badge>
                    ) : null}
                  </Td>
                  <Td>{entry.rollNumber || '—'}</Td>
                  <Td isNumeric>{entry.answered}</Td>
                  {hasGradableSlides && <Td isNumeric>{entry.correct}</Td>}
                  {hasGradableSlides && (
                    <Td isNumeric>
                      {entry.score}
                      <Text as="span" opacity={0.5}>
                        /{maxScore}
                      </Text>
                    </Td>
                  )}
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Box>
      </SectionCard>

      <SectionCard title="Slide by slide">
        <Accordion allowMultiple>
          {slides.map((slide) => (
            <AccordionItem key={slide.slideId}>
              <AccordionButton {...buttonTextStyles}>
                <HStack flex="1" spacing={3} textAlign="left">
                  <Badge>{slide.index + 1}</Badge>
                  <Text fontSize="sm" flex="1" noOfLines={1}>
                    {richTextToPlain(slide.question)}
                  </Text>
                  <Text fontSize="xs" opacity={0.6} whiteSpace="nowrap">
                    {slide.responses} {slide.responses === 1 ? 'answer' : 'answers'}
                    {slide.correctPercent !== null ? ` · ${slide.correctPercent}% correct` : ''}
                    {slide.avgResponseMs !== null
                      ? ` · ${(slide.avgResponseMs / 1000).toFixed(1)}s avg`
                      : ''}
                  </Text>
                </HStack>
                <AccordionIcon />
              </AccordionButton>
              <AccordionPanel>
                {slide.responses ? (
                  <ShortResults results={slide.results} />
                ) : (
                  <Text fontSize="sm" opacity={0.6}>
                    Never opened, or nobody answered.
                  </Text>
                )}
              </AccordionPanel>
            </AccordionItem>
          ))}
        </Accordion>
      </SectionCard>
    </VStack>
  );
}
