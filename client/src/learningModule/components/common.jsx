import React, { useEffect, useState } from 'react';
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

/**
 * The text colour a bare-button control has to state for itself.
 *
 * Chakra renders MenuItem and AccordionButton as plain `<button>`s and its
 * theme sets no colour on them, so they take whatever they inherit — except a
 * global `button { color: #fff }` in timetableadmin/Timetable.css matches the
 * element directly, and a matched rule beats an inherited value however far
 * away it was written. The result is white text on a white menu. Spread this
 * onto any such control that is not already saying its own colour.
 */
export const buttonTextStyles = { color: 'gray.800' };

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

/**
 * A deadline that counts down rather than sitting there as a date.
 *
 * "Due 14 Aug, 23:59" is a date a student has to do arithmetic on. A clock that
 * says "4h 12m left" is the thing they actually want to know, and it is the
 * last hour — where this switches to seconds and turns red — that the format
 * exists for.
 *
 * The tick rate follows the urgency: once a second under the last hour, once a
 * minute otherwise. A class list can hold thirty of these, and thirty
 * per-second timers to redraw "in 6 days" would be pure waste.
 */
export function DeadlineCountdown({ dueDate, prefix = 'Due in', size = 'sm', ...rest }) {
  const target = dueDate ? new Date(dueDate).getTime() : null;
  const [remaining, setRemaining] = useState(() => (target ? target - Date.now() : null));

  useEffect(() => {
    if (!target) {
      setRemaining(null);
      return undefined;
    }
    const tick = () => setRemaining(target - Date.now());
    tick();
    // Re-armed each tick rather than a fixed interval, so crossing into the
    // last hour speeds it up without waiting for a remount.
    let timer = null;
    const schedule = () => {
      const left = target - Date.now();
      timer = setTimeout(() => {
        tick();
        schedule();
      }, Math.abs(left) < 3600_000 ? 1000 : 60_000);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [target]);

  if (!target || remaining === null) return null;

  const overdue = remaining < 0;
  const left = Math.abs(remaining);
  const days = Math.floor(left / 864e5);
  const hours = Math.floor((left % 864e5) / 36e5);
  const minutes = Math.floor((left % 36e5) / 6e4);
  const seconds = Math.floor((left % 6e4) / 1000);

  let text;
  if (days > 0) text = `${days}d ${hours}h`;
  else if (hours > 0) text = `${hours}h ${minutes}m`;
  else if (minutes > 0) text = `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  else text = `${seconds}s`;

  // Urgency in the colour, so a glance down a list finds the one closing today.
  const scheme = overdue ? 'red' : left < 36e5 ? 'red' : left < 864e5 ? 'orange' : 'gray';

  return (
    <Tooltip label={`Deadline: ${formatDateTime(dueDate)}`}>
      <Badge
        colorScheme={scheme}
        borderRadius="full"
        px={2}
        fontSize={size === 'xs' ? '0.65rem' : '0.75rem'}
        fontVariantNumeric="tabular-nums"
        {...rest}
      >
        {overdue ? `Overdue by ${text}` : `${prefix} ${text}`}
      </Badge>
    </Tooltip>
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
