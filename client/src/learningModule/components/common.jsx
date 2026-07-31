import React from 'react';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Center,
  Flex,
  HStack,
  Heading,
  Spinner,
  Text,
  Tooltip,
  useClipboard,
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

/**
 * The refusals a user can act on, keyed by the `code` the API sends alongside a
 * 403 (see server middleware/lmAuth.js loadClass). They are not failures: there
 * is nothing to retry, and "Something went wrong" would hide the one thing the
 * user needs to know — whether their account lacks the role, or they are simply
 * not enrolled in this subject.
 */
const ACCESS_DENIED = {
  ROLE_REQUIRED: { icon: '🔒', title: 'You do not have the necessary role for these pages' },
  NOT_ENROLLED: { icon: '📕', title: 'You do not have access to this subject' },
  JOIN_PENDING: { icon: '⏳', title: 'Waiting for your teacher to approve you' },
};

export const accessDeniedOf = (error) =>
  error?.status === 403 ? ACCESS_DENIED[error?.payload?.code] || null : null;

export function ErrorState({ error, onRetry }) {
  if (!error) return null;

  // The wording itself stays server-side, so it can name the subject and stay
  // in step with the rule that produced it.
  const denied = accessDeniedOf(error);
  if (denied) {
    return (
      <Box
        my={4}
        p={5}
        bg="white"
        borderWidth="1px"
        borderColor="orange.200"
        borderLeftWidth="4px"
        borderLeftColor="orange.400"
        borderRadius="lg"
      >
        <Flex align="flex-start" gap={4}>
          <Text fontSize="2xl" lineHeight="1.2" aria-hidden="true">
            {denied.icon}
          </Text>
          <Box>
            <Heading size="sm" color="gray.800">
              {denied.title}
            </Heading>
            <Text fontSize="sm" color="gray.600" mt={2}>
              {error.message}
            </Text>
          </Box>
        </Flex>
      </Box>
    );
  }

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

/**
 * Copies an in-app route as a full, shareable URL. The stored value is absolute
 * because the link is meant to leave the app — pasted into a chat, an email or
 * a class announcement — where a bare "/learning/…" path is useless.
 */
export function CopyLinkButton({ to, label = 'Copy link', copiedLabel = 'Link copied!', ...rest }) {
  const url = typeof window === 'undefined' ? to : new URL(to, window.location.origin).href;
  const { onCopy, hasCopied } = useClipboard(url);
  return (
    <Tooltip label={hasCopied ? copiedLabel : url} placement="top">
      <Button size="sm" variant="outline" onClick={onCopy} {...rest}>
        {hasCopied ? '✓ Copied' : `🔗 ${label}`}
      </Button>
    </Tooltip>
  );
}

/**
 * Theme-colour swatches. The selected state is drawn with a ring (box-shadow)
 * and a tick rather than a border width, so the choice reads at a glance and
 * does not depend on the global border-style reset.
 */
export function ColorPicker({ value, options, onChange, label = 'colour' }) {
  return (
    <HStack spacing={3} flexWrap="wrap">
      {options.map((color) => {
        const selected = value === color;
        return (
          <Box
            key={color}
            as="button"
            type="button"
            aria-label={`Use ${label} ${color}`}
            aria-pressed={selected}
            w="32px"
            h="32px"
            borderRadius="full"
            bg={color}
            display="flex"
            alignItems="center"
            justifyContent="center"
            color="white"
            fontSize="sm"
            fontWeight="700"
            lineHeight="1"
            transition="transform 0.12s ease, box-shadow 0.12s ease"
            transform={selected ? 'scale(1.15)' : 'none'}
            boxShadow={
              selected
                ? `0 0 0 2px #fff, 0 0 0 4px ${color}`
                : 'inset 0 0 0 1px rgba(0, 0, 0, 0.15)'
            }
            _hover={{ transform: selected ? 'scale(1.15)' : 'scale(1.1)' }}
            _focusVisible={{ outline: '2px solid', outlineColor: 'blue.500', outlineOffset: '2px' }}
            onClick={() => onChange(color)}
          >
            {selected ? '✓' : ''}
          </Box>
        );
      })}
    </HStack>
  );
}

/** Miniature of the dashboard class card, so the theme colour is visible while picking it. */
export function ClassCardPreview({ color, title, subtitle }) {
  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="lg" overflow="hidden">
      <Box bg={color} px={4} py={3} color="white" transition="background-color 0.15s ease">
        <Text fontWeight="700" noOfLines={1}>
          {title}
        </Text>
        <Text fontSize="xs" opacity={0.9} noOfLines={1}>
          {subtitle || ' '}
        </Text>
      </Box>
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
