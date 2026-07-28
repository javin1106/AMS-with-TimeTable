import React from 'react';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Center,
  Flex,
  Heading,
  Spinner,
  Text,
  Tooltip,
} from '@chakra-ui/react';
import { formatDateTime, relativeTime } from '../format';

/** Consistent loading state for every panel in the module. */
export function Loading({ label = 'Loading…', minH = '200px' }) {
  return (
    <Center minH={minH} flexDirection="column" gap={3}>
      <Spinner thickness="3px" speed="0.7s" color="blue.500" size="lg" />
      <Text color="gray.500" fontSize="sm">
        {label}
      </Text>
    </Center>
  );
}

export function ErrorState({ error, onRetry }) {
  if (!error) return null;
  return (
    <Alert status="error" borderRadius="md" my={4} alignItems="flex-start">
      <AlertIcon />
      <Box>
        <Text fontWeight="600">{error.message || 'Something went wrong.'}</Text>
        {onRetry && (
          <Text
            as="button"
            onClick={onRetry}
            mt={1}
            fontSize="sm"
            textDecoration="underline"
            color="red.700"
          >
            Try again
          </Text>
        )}
      </Box>
    </Alert>
  );
}

export function EmptyState({ icon = '📭', title, description, action }) {
  return (
    <Center flexDirection="column" py={12} px={6} textAlign="center" gap={2}>
      <Text fontSize="4xl">{icon}</Text>
      <Heading size="sm" color="gray.700">
        {title}
      </Heading>
      {description && (
        <Text color="gray.500" fontSize="sm" maxW="420px">
          {description}
        </Text>
      )}
      {action && <Box pt={3}>{action}</Box>}
    </Center>
  );
}

export function SectionCard({ title, subtitle, action, children, ...rest }) {
  return (
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={5} {...rest}>
      {(title || action) && (
        <Flex justify="space-between" align="flex-start" mb={subtitle ? 1 : 4} gap={3}>
          <Box>
            {title && (
              <Heading size="sm" color="gray.800">
                {title}
              </Heading>
            )}
            {subtitle && (
              <Text fontSize="xs" color="gray.500" mt={1}>
                {subtitle}
              </Text>
            )}
          </Box>
          {action}
        </Flex>
      )}
      {subtitle && <Box mb={4} />}
      {children}
    </Box>
  );
}

export function StatTile({ label, value, hint, accent = 'blue.500' }) {
  return (
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={4}>
      <Text fontSize="xs" textTransform="uppercase" letterSpacing="wide" color="gray.500">
        {label}
      </Text>
      <Text fontSize="2xl" fontWeight="700" color={accent} lineHeight="1.2" mt={1}>
        {value ?? '—'}
      </Text>
      {hint && (
        <Text fontSize="xs" color="gray.500" mt={1}>
          {hint}
        </Text>
      )}
    </Box>
  );
}

const STATE_STYLES = {
  assigned: { colorScheme: 'gray', label: 'Assigned' },
  turned_in: { colorScheme: 'green', label: 'Turned in' },
  returned: { colorScheme: 'blue', label: 'Returned' },
  reclaimed: { colorScheme: 'orange', label: 'Returned for edits' },
  draft: { colorScheme: 'gray', label: 'Draft' },
  scheduled: { colorScheme: 'purple', label: 'Scheduled' },
  published: { colorScheme: 'green', label: 'Published' },
};

export function StateBadge({ state, late }) {
  const style = STATE_STYLES[state] || { colorScheme: 'gray', label: state };
  return (
    <Flex gap={1} align="center" display="inline-flex">
      <Badge colorScheme={style.colorScheme} borderRadius="full" px={2} fontSize="0.7rem">
        {style.label}
      </Badge>
      {late && (
        <Badge colorScheme="red" borderRadius="full" px={2} fontSize="0.7rem">
          Late
        </Badge>
      )}
    </Flex>
  );
}

export function DueBadge({ dueDate }) {
  if (!dueDate) {
    return (
      <Text fontSize="xs" color="gray.500">
        No due date
      </Text>
    );
  }
  const overdue = new Date(dueDate) < new Date();
  return (
    <Tooltip label={formatDateTime(dueDate)}>
      <Text fontSize="xs" color={overdue ? 'red.500' : 'gray.600'} fontWeight={overdue ? '600' : '400'}>
        Due {relativeTime(dueDate)}
      </Text>
    </Tooltip>
  );
}
