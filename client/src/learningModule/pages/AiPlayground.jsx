import React from 'react';
import { Badge, Box, Flex, HStack, Heading, SimpleGrid, Text } from '@chakra-ui/react';

// Placeholder tab. The teaching side of the AI features already ships as AI
// Studio; this is the student-facing counterpart, announced here so the class
// knows it is coming rather than finding an empty tab later.
const PLANNED = [
  {
    icon: '💬',
    title: 'Ask your lectures',
    description: 'Put a question to the transcript of any lecture in this class and get the passage it came from.',
  },
  {
    icon: '🃏',
    title: 'Practice cards',
    description: 'Flashcards and practice questions generated from the material your teacher has posted.',
  },
  {
    icon: '🧭',
    title: 'Explain this',
    description: 'Step through a worked solution at your own pace, with hints instead of answers.',
  },
  {
    icon: '📈',
    title: 'Know your gaps',
    description: 'A read on the topics your quiz attempts say you should revisit first.',
  },
];

export default function AiPlayground() {
  return (
    <Box>
      <Box
        bg="white"
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="lg"
        px={{ base: 6, md: 10 }}
        py={{ base: 10, md: 14 }}
        textAlign="center"
        mb={5}
      >
        <Text fontSize="4xl" mb={2}>
          🤖
        </Text>
        <HStack justify="center" spacing={3} mb={3}>
          <Heading size="lg" color="gray.800">
            AI Playground
          </Heading>
          <Badge colorScheme="purple" borderRadius="full" px={3} py={1}>
            Launching soon
          </Badge>
        </HStack>
        <Text color="gray.600" fontSize="sm" maxW="520px" mx="auto">
          A space to study with AI built around this class — your lectures, your material, your
          quiz attempts. It is being built now and will appear right here.
        </Text>
      </Box>

      <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4}>
        {PLANNED.map((feature) => (
          <Flex
            key={feature.title}
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="lg"
            p={5}
            gap={4}
            align="flex-start"
            opacity={0.85}
          >
            <Text fontSize="2xl">{feature.icon}</Text>
            <Box>
              <Heading size="sm" color="gray.800" mb={1}>
                {feature.title}
              </Heading>
              <Text fontSize="sm" color="gray.600">
                {feature.description}
              </Text>
            </Box>
          </Flex>
        ))}
      </SimpleGrid>
    </Box>
  );
}
