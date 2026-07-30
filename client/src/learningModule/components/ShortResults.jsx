import React from 'react';
import {
  Badge,
  Box,
  Flex,
  HStack,
  Progress,
  SimpleGrid,
  Stat,
  StatLabel,
  StatNumber,
  Text,
  VStack,
  Wrap,
  WrapItem,
  useColorModeValue,
} from '@chakra-ui/react';

import RichText from './RichText';

/**
 * Renders one slide's aggregate.
 *
 * The same component draws the projector, the student's phone and the
 * post-session report, so there is only one place where a chart can be wrong.
 * `size="lg"` scales the type up for a lecture theatre; the layout is otherwise
 * identical, which is what keeps the two views honest with each other.
 *
 * All of the numbers come pre-computed from the server's aggregator — this file
 * only lays them out. Recomputing percentages here would let the projector and
 * the phone disagree.
 */

const barColour = (isCorrect) => {
  if (isCorrect === true) return 'green.400';
  if (isCorrect === false) return 'gray.400';
  return 'blue.400';
};

function ChoiceBars({ results, size }) {
  const big = size === 'lg';
  const track = useColorModeValue('gray.100', 'whiteAlpha.200');

  return (
    <VStack align="stretch" spacing={big ? 5 : 3}>
      {(results.options || []).map((option) => (
        <Box key={option.index}>
          <Flex justify="space-between" align="baseline" mb={1} gap={3}>
            <HStack spacing={2} minW={0}>
              <Text fontSize={big ? '2xl' : 'sm'} fontWeight="600" noOfLines={2}>
                {option.label || `Option ${option.index + 1}`}
              </Text>
              {option.isCorrect === true && (
                <Badge colorScheme="green" fontSize={big ? 'md' : 'xs'}>
                  correct
                </Badge>
              )}
            </HStack>
            <Text fontSize={big ? '2xl' : 'sm'} fontWeight="700" whiteSpace="nowrap">
              {option.count}
              <Text as="span" fontWeight="400" opacity={0.6}>
                {' '}
                · {option.percent}%
              </Text>
            </Text>
          </Flex>
          <Box bg={track} borderRadius="full" h={big ? '28px' : '14px'} overflow="hidden">
            <Box
              h="100%"
              w={`${Math.min(100, option.percent)}%`}
              bg={barColour(option.isCorrect)}
              borderRadius="full"
              transition="width 400ms ease"
            />
          </Box>
        </Box>
      ))}
    </VStack>
  );
}

function WordCloud({ results, size }) {
  const big = size === 'lg';
  const max = results.maxCount || 1;
  const words = results.words || [];

  if (!words.length) return <Text opacity={0.6}>No words yet.</Text>;

  return (
    <Wrap spacing={big ? 5 : 3} justify="center" align="center">
      {words.map((word) => {
        // Font size tracks frequency, floored so a one-vote word is still
        // legible from the back of the room rather than shrinking to nothing.
        const weight = word.count / max;
        const min = big ? 20 : 12;
        const span = big ? 64 : 22;
        return (
          <WrapItem key={word.text}>
            <Text
              fontSize={`${Math.round(min + weight * span)}px`}
              lineHeight="1.1"
              fontWeight={weight > 0.6 ? '800' : '600'}
              color={weight > 0.6 ? 'blue.500' : weight > 0.3 ? 'blue.400' : 'gray.500'}
              title={`${word.count} ${word.count === 1 ? 'mention' : 'mentions'}`}
            >
              {word.text}
            </Text>
          </WrapItem>
        );
      })}
    </Wrap>
  );
}

function ScaleHistogram({ results, size }) {
  const big = size === 'lg';
  const buckets = results.buckets || [];
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const track = useColorModeValue('gray.100', 'whiteAlpha.200');

  return (
    <VStack align="stretch" spacing={big ? 6 : 4}>
      <Flex align="flex-end" gap={big ? 4 : 2} h={big ? '260px' : '120px'}>
        {buckets.map((bucket) => (
          <VStack key={bucket.value} flex="1" spacing={1} justify="flex-end" h="100%">
            <Text fontSize={big ? 'xl' : 'xs'} fontWeight="700">
              {bucket.count || ''}
            </Text>
            <Box
              w="100%"
              bg={bucket.count ? 'purple.400' : track}
              // A zero bar keeps a sliver of height so the axis reads as a scale
              // with a gap rather than as a shorter scale.
              h={`${Math.max(2, (bucket.count / max) * 100)}%`}
              borderTopRadius="md"
              transition="height 400ms ease"
            />
            <Text fontSize={big ? 'lg' : 'xs'} fontWeight="600">
              {bucket.value}
            </Text>
          </VStack>
        ))}
      </Flex>

      <Flex justify="space-between" fontSize={big ? 'lg' : 'xs'} opacity={0.7}>
        <Text>{results.minLabel || results.min}</Text>
        <Text>{results.maxLabel || results.max}</Text>
      </Flex>

      <SimpleGrid columns={2} spacing={4}>
        <Stat>
          <StatLabel fontSize={big ? 'md' : 'xs'}>Average</StatLabel>
          <StatNumber fontSize={big ? '4xl' : 'xl'}>{results.average ?? '—'}</StatNumber>
        </Stat>
        <Stat>
          <StatLabel fontSize={big ? 'md' : 'xs'}>Median</StatLabel>
          <StatNumber fontSize={big ? '4xl' : 'xl'}>{results.median ?? '—'}</StatNumber>
        </Stat>
      </SimpleGrid>
    </VStack>
  );
}

function NumericSpread({ results, size }) {
  const big = size === 'lg';
  const buckets = results.buckets || [];
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const track = useColorModeValue('gray.100', 'whiteAlpha.200');

  return (
    <VStack align="stretch" spacing={big ? 6 : 4}>
      {buckets.length ? (
        <Flex align="flex-end" gap={1} h={big ? '220px' : '100px'}>
          {buckets.map((bucket) => (
            <VStack key={`${bucket.from}-${bucket.to}`} flex="1" spacing={1} justify="flex-end" h="100%">
              <Box
                w="100%"
                bg={bucket.count ? 'teal.400' : track}
                h={`${Math.max(2, (bucket.count / max) * 100)}%`}
                borderTopRadius="sm"
                title={`${bucket.from} – ${bucket.to}: ${bucket.count}`}
                transition="height 400ms ease"
              />
              <Text fontSize={big ? 'sm' : '2xs'} opacity={0.6} noOfLines={1}>
                {bucket.from}
              </Text>
            </VStack>
          ))}
        </Flex>
      ) : (
        <Text opacity={0.6}>No answers yet.</Text>
      )}

      <SimpleGrid columns={{ base: 2, md: 4 }} spacing={4}>
        {[
          ['Average', results.average],
          ['Median', results.median],
          ['Lowest', results.lowest],
          ['Highest', results.highest],
        ].map(([label, value]) => (
          <Stat key={label}>
            <StatLabel fontSize={big ? 'md' : 'xs'}>{label}</StatLabel>
            <StatNumber fontSize={big ? '3xl' : 'lg'}>{value ?? '—'}</StatNumber>
          </Stat>
        ))}
      </SimpleGrid>

      {results.correctAnswers?.length ? (
        <Badge colorScheme="green" alignSelf="flex-start" fontSize={big ? 'lg' : 'sm'} px={3} py={1}>
          Answer: {results.correctAnswers[0]}
        </Badge>
      ) : null}
    </VStack>
  );
}

function OpenCards({ results, size }) {
  const big = size === 'lg';
  const bg = useColorModeValue('gray.50', 'whiteAlpha.100');
  const entries = results.entries || [];

  if (!entries.length) return <Text opacity={0.6}>No answers yet.</Text>;

  return (
    <SimpleGrid columns={{ base: 1, md: big ? 3 : 2 }} spacing={big ? 4 : 3}>
      {entries.map((entry, index) => (
        <Box
          key={`${entry.at || index}-${index}`}
          bg={bg}
          borderRadius="lg"
          p={big ? 5 : 3}
          borderWidth="1px"
        >
          <Text fontSize={big ? 'xl' : 'sm'} whiteSpace="pre-wrap">
            {entry.text}
          </Text>
          {entry.name ? (
            <Text mt={2} fontSize={big ? 'md' : 'xs'} opacity={0.6}>
              — {entry.name}
            </Text>
          ) : null}
        </Box>
      ))}
    </SimpleGrid>
  );
}

function RankingBoard({ results, size }) {
  const big = size === 'lg';
  const items = results.items || [];
  const max = Math.max(1, ...items.map((item) => item.points));
  const track = useColorModeValue('gray.100', 'whiteAlpha.200');

  return (
    <VStack align="stretch" spacing={big ? 4 : 3}>
      {items.map((item) => (
        <Flex key={item.index} align="center" gap={big ? 5 : 3}>
          <Box
            minW={big ? '52px' : '32px'}
            textAlign="center"
            fontWeight="800"
            fontSize={big ? '3xl' : 'md'}
            opacity={0.5}
          >
            {item.rank}
          </Box>
          <Box flex="1" minW={0}>
            <Flex justify="space-between" mb={1} gap={3}>
              <Text fontSize={big ? '2xl' : 'sm'} fontWeight="600" noOfLines={1}>
                {item.label}
              </Text>
              <Text fontSize={big ? 'xl' : 'xs'} opacity={0.7} whiteSpace="nowrap">
                {item.points} pts
              </Text>
            </Flex>
            <Box bg={track} borderRadius="full" h={big ? '20px' : '10px'} overflow="hidden">
              <Box
                h="100%"
                w={`${(item.points / max) * 100}%`}
                bg="orange.400"
                borderRadius="full"
                transition="width 400ms ease"
              />
            </Box>
          </Box>
        </Flex>
      ))}

      {results.correctOrder?.length ? (
        <Text fontSize={big ? 'lg' : 'sm'} color="green.500" fontWeight="600">
          Correct order: {results.correctOrder.join(' → ')}
        </Text>
      ) : null}
    </VStack>
  );
}

const RENDERERS = {
  mcq: ChoiceBars,
  msq: ChoiceBars,
  truefalse: ChoiceBars,
  wordcloud: WordCloud,
  scale: ScaleHistogram,
  numeric: NumericSpread,
  open: OpenCards,
  ranking: RankingBoard,
};

export default function ShortResults({ results, size = 'md', showQuestion = false }) {
  if (!results) return null;
  const Renderer = RENDERERS[results.type];
  const big = size === 'lg';

  return (
    <VStack align="stretch" spacing={big ? 6 : 4}>
      {showQuestion && results.question ? (
        <Box fontSize={big ? '3xl' : 'md'} fontWeight="700">
          <RichText>{results.question}</RichText>
        </Box>
      ) : null}

      {Renderer ? <Renderer results={results} size={size} /> : <Text opacity={0.6}>Nothing to show.</Text>}

      {results.gradable && results.correctCount !== undefined ? (
        <Box>
          <Flex justify="space-between" fontSize={big ? 'lg' : 'sm'} mb={1}>
            <Text fontWeight="600">
              {results.correctCount} of {results.totalResponses} correct
            </Text>
            <Text opacity={0.7}>
              {results.totalResponses
                ? `${Math.round((results.correctCount / results.totalResponses) * 100)}%`
                : '—'}
            </Text>
          </Flex>
          <Progress
            value={results.totalResponses ? (results.correctCount / results.totalResponses) * 100 : 0}
            colorScheme="green"
            size={big ? 'md' : 'sm'}
            borderRadius="full"
          />
        </Box>
      ) : null}

      {results.explanation ? (
        <Box
          borderLeftWidth="4px"
          borderLeftColor="blue.400"
          pl={4}
          fontSize={big ? 'xl' : 'sm'}
        >
          <RichText>{results.explanation}</RichText>
        </Box>
      ) : null}
    </VStack>
  );
}
