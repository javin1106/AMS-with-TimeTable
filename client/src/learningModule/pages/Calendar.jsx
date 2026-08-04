import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  HStack,
  Heading,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Text,
  Wrap,
  WrapItem,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading, SectionCard } from '../components/common';
import { courseworkLink, courseworkMeta, formatDate, formatDateTime } from '../format';

const startOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1);
const endOfMonth = (date) => new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);
const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "YYYY-MM-DD" in local time — the key the attendance module stores holidays under. */
const dayKey = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
};

/** The inverse of dayKey. `new Date("2026-07-15")` is UTC midnight, which lands
 *  on the previous day west of Greenwich — build the local date explicitly. */
const parseDayKey = (key) => {
  const [year, month, day] = String(key).split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const EMPTY = { coursework: [], quizzes: [], shorts: [], nonWorkingDays: [] };

const isTeacher = (role) => role === 'teacher' || role === 'co-teacher';

const LEGEND = [
  { color: 'gray.500', label: 'Coursework' },
  { color: 'purple.500', label: 'Quiz' },
  { color: 'teal.500', label: 'Short' },
  { color: 'red.200', label: 'Non-working day' },
];

/** How many chips a day cell shows before it collapses the rest into "+N more". */
const CHIPS_PER_CELL = 3;

/**
 * The subject short name a chip is labelled with. The subject code is what a
 * timetable calls a subject ("CS301"), so it wins; a class without one falls
 * back to its subject, then its name, clipped so a chip stays one line. The
 * untruncated value always survives in the chip's tooltip.
 */
const subjectShort = (klass) => {
  const raw = String(klass?.subjectCode || klass?.subject || klass?.name || '').trim();
  return raw.length > 14 ? `${raw.slice(0, 13)}…` : raw;
};

/** Clock time, for the entries where the hour actually means something. */
const formatTime = (value) =>
  new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

/** A single chip inside a day cell, rendered as a link only when there is one. */
function DayChip({ to, bg, subject, label, title }) {
  return (
    <Box
      {...(to ? { as: RouterLink, to } : {})}
      display="block"
      mt={1}
      px={1}
      py={0.5}
      borderRadius="sm"
      bg={bg}
      color="white"
      fontSize="0.65rem"
      noOfLines={1}
      _hover={to ? { opacity: 0.85, textDecoration: 'none' } : undefined}
      title={title || label}
      // The cell behind the chip opens the day's list; a chip that navigates
      // somewhere of its own should not do both.
      onClick={to ? (event) => event.stopPropagation() : undefined}
    >
      {subject && (
        <Text as="span" fontWeight="700" mr={1}>
          {subject}
        </Text>
      )}
      {label}
    </Box>
  );
}

/** Everything happening on one day, for when a cell has more than it can show. */
function DayDetailModal({ date, items, holiday, onClose }) {
  return (
    <Modal isOpen={!!date} onClose={onClose} size="lg" scrollBehavior="inside" isCentered>
      <ModalOverlay />
      <ModalContent>
        <ModalHeader fontSize="md">
          {date && formatDate(date)}
          <Text fontSize="xs" color="gray.500" fontWeight="400">
            {items.length} {items.length === 1 ? 'activity' : 'activities'}
          </Text>
        </ModalHeader>
        <ModalCloseButton />
        <ModalBody pb={4}>
          {holiday && (
            <Flex align="center" gap={3} py={2.5} borderBottomWidth="1px" borderColor="gray.100">
              <Text>🏖️</Text>
              <Box flex="1" minW={0}>
                <Text fontSize="sm" fontWeight="500">
                  {holiday.remark}
                </Text>
                <Text fontSize="xs" color="gray.500">
                  Non-working day{holiday.session ? ` · ${holiday.session}` : ''}
                </Text>
              </Box>
              <Badge colorScheme="red">Off</Badge>
            </Flex>
          )}
          {items.length === 0 && !holiday ? (
            <EmptyState icon="📅" title="Nothing scheduled on this day" />
          ) : (
            items.map((item) => (
              <Flex
                key={item.key}
                {...(item.to ? { as: RouterLink, to: item.to, onClick: onClose } : {})}
                align="center"
                gap={3}
                py={2.5}
                borderBottomWidth="1px"
                borderColor="gray.100"
                _hover={item.to ? { bg: 'gray.50', textDecoration: 'none' } : undefined}
              >
                <Text>{item.icon}</Text>
                <Box flex="1" minW={0}>
                  <Flex align="center" gap={2} minW={0}>
                    {item.subject && (
                      <Badge bg={item.bg} color="white" fontSize="0.6rem">
                        {item.subject}
                      </Badge>
                    )}
                    <Text fontSize="sm" fontWeight="500" noOfLines={1}>
                      {item.title}
                    </Text>
                  </Flex>
                  <Text fontSize="xs" color="gray.500" noOfLines={1}>
                    {item.kindLabel}
                    {item.showTime ? ` · ${formatTime(item.at)}` : ''}
                    {item.className ? ` · ${item.className}` : ''}
                  </Text>
                </Box>
                {item.badge}
              </Flex>
            ))
          )}
        </ModalBody>
        <ModalFooter pt={0}>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

export default function Calendar() {
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // The day whose full activity list is open, or null.
  const [selectedDay, setSelectedDay] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // The open day belongs to the month being left behind.
    setSelectedDay(null);
    try {
      const result = await lmApi.calendar({
        from: startOfMonth(cursor).toISOString(),
        to: endOfMonth(cursor).toISOString(),
      });
      setData({ ...EMPTY, ...result });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [cursor]);

  useEffect(() => {
    load();
  }, [load]);

  // Weeks start on Monday, which is how the timetable module presents them.
  const cells = useMemo(() => {
    const first = startOfMonth(cursor);
    const last = endOfMonth(cursor);
    const leading = (first.getDay() + 6) % 7;
    const days = [];
    for (let i = 0; i < leading; i += 1) days.push(null);
    for (let day = 1; day <= last.getDate(); day += 1) {
      days.push(new Date(cursor.getFullYear(), cursor.getMonth(), day));
    }
    return days;
  }, [cursor]);

  // One pass turns the three feeds into a single day → chips map so a cell does
  // not have to scan every list to draw itself.
  const byDay = useMemo(() => {
    const map = new Map();
    const push = (value, chip) => {
      const key = dayKey(value);
      map.set(key, [...(map.get(key) || []), chip]);
    };

    data.coursework.forEach((item) => {
      const meta = courseworkMeta(item);
      const subject = subjectShort(item.class);
      const kindLabel = `${meta.label} ${item.dateKind === 'posted' ? 'posted' : 'due'}`;
      const at = item.calendarDate || item.dueDate;
      push(at, {
        key: `cw-${item._id}`,
        at,
        showTime: false,
        bg: item.class?.coverColor || 'gray.500',
        icon: meta.icon,
        subject,
        title: item.title,
        kindLabel,
        className: item.class?.name || '',
        label: `${meta.icon} ${item.title}`,
        tooltip: `${item.class?.subject || item.class?.name || ''} — ${kindLabel}: ${item.title}`,
        to: courseworkLink(item),
        badge: item.mySubmissionState ? (
          <Badge colorScheme={item.mySubmissionState === 'assigned' ? 'orange' : 'green'}>
            {item.mySubmissionState === 'assigned' ? 'Not done' : item.mySubmissionState}
          </Badge>
        ) : null,
      });
    });

    data.quizzes.forEach((quiz) => {
      const subject = subjectShort(quiz.class);
      push(quiz.conductedAt, {
        key: `qz-${quiz._id}`,
        at: quiz.conductedAt,
        showTime: true,
        bg: 'purple.500',
        icon: '🧠',
        subject,
        title: quiz.title,
        kindLabel: quiz.timeLimitMinutes ? `Quiz · ${quiz.timeLimitMinutes} min` : 'Quiz',
        className: quiz.class?.name || '',
        label: `🧠 ${quiz.title}`,
        tooltip: `${quiz.class?.subject || quiz.class?.name || ''} — Quiz: ${quiz.title}`,
        to: `/learning/class/${quiz.classId}/quiz/${quiz._id}`,
        badge:
          quiz.myAttemptStatus === 'submitted' ? (
            <Badge colorScheme="green">
              {quiz.myPercent === null ? 'Submitted' : `${quiz.myPercent}%`}
            </Badge>
          ) : quiz.myAttemptStatus ? (
            <Badge colorScheme="orange">{quiz.myAttemptStatus.replace('_', ' ')}</Badge>
          ) : null,
      });
    });

    data.shorts.forEach((short) => {
      const subject = subjectShort(short.class);
      push(short.startedAt, {
        key: `sh-${short._id}`,
        at: short.startedAt,
        showTime: true,
        bg: 'teal.500',
        icon: '⚡',
        subject,
        title: short.title,
        kindLabel: 'Short presented',
        className: short.class?.name || '',
        label: `⚡ ${short.title}`,
        tooltip: `${short.class?.subject || short.class?.name || ''} — Short: ${short.title}`,
        // Only a teacher has somewhere to go: a finished session's report.
        to: isTeacher(short.myRole)
          ? `/learning/class/${short.classId}/short/${short.shortId}/report/${short._id}`
          : null,
        badge: (
          <Badge colorScheme={short.status === 'live' ? 'red' : 'gray'}>
            {short.status === 'live' ? 'Live' : `${short.participantCount} joined`}
          </Badge>
        ),
      });
    });

    // Chips are pushed feed by feed, so a day holds coursework, then quizzes,
    // then Shorts; ordering by time is what a reader expects instead.
    map.forEach((entries) => entries.sort((a, b) => new Date(a.at) - new Date(b.at)));
    return map;
  }, [data]);

  const holidayByDay = useMemo(
    () => new Map(data.nonWorkingDays.map((day) => [day.date, day])),
    [data.nonWorkingDays],
  );

  const today = new Date();
  const monthLabel = cursor.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={4} gap={3} wrap="wrap">
        <Box>
          <Heading size="lg">Calendar</Heading>
          <Text color="gray.500" fontSize="sm">
            Coursework due dates, quizzes, Shorts and institute holidays. Click a day to see
            everything on it.
          </Text>
        </Box>
        <HStack>
          <Button size="sm" variant="outline" onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}>
            ←
          </Button>
          <Text fontWeight="600" minW="160px" textAlign="center">
            {monthLabel}
          </Text>
          <Button size="sm" variant="outline" onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}>
            →
          </Button>
          <Button size="sm" onClick={() => setCursor(startOfMonth(new Date()))}>
            Today
          </Button>
        </HStack>
      </Flex>

      <ErrorState error={error} onRetry={load} />

      {loading ? (
        <Loading />
      ) : (
        <>
          <Wrap spacing={4} mb={3}>
            {LEGEND.map((entry) => (
              <WrapItem key={entry.label}>
                <HStack spacing={2}>
                  <Box w="10px" h="10px" borderRadius="sm" bg={entry.color} />
                  <Text fontSize="xs" color="gray.600">
                    {entry.label}
                  </Text>
                </HStack>
              </WrapItem>
            ))}
          </Wrap>

          <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={3} mb={5} overflowX="auto">
            <Grid templateColumns="repeat(7, minmax(90px, 1fr))" gap={1} minW="640px">
              {WEEKDAYS.map((day) => (
                <Text key={day} fontSize="xs" fontWeight="600" color="gray.500" textAlign="center" py={1}>
                  {day}
                </Text>
              ))}
              {cells.map((date, index) => {
                if (!date) return <Box key={`pad-${index}`} />;
                const key = dayKey(date);
                const dayItems = byDay.get(key) || [];
                const holiday = holidayByDay.get(key);
                const isToday = sameDay(date, today);

                let borderColor = 'gray.100';
                let bg = 'white';
                if (holiday) {
                  borderColor = 'red.200';
                  bg = 'red.50';
                }
                if (isToday) {
                  borderColor = 'blue.400';
                  bg = holiday ? 'red.50' : 'blue.50';
                }

                const openable = dayItems.length > 0 || !!holiday;
                const open = () => openable && setSelectedDay(date);

                return (
                  <Box
                    key={date.toISOString()}
                    minH="86px"
                    borderWidth="1px"
                    borderColor={borderColor}
                    bg={bg}
                    borderRadius="md"
                    p={1.5}
                    // Any day with something on it opens the full list — the
                    // cell only ever has room for the first few chips.
                    {...(openable
                      ? {
                          role: 'button',
                          tabIndex: 0,
                          cursor: 'pointer',
                          onClick: open,
                          onKeyDown: (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              open();
                            }
                          },
                          'aria-label': `${formatDate(date)} — ${dayItems.length} activities`,
                          _hover: { borderColor: 'blue.300' },
                        }
                      : {})}
                  >
                    <Flex align="center" justify="space-between" gap={1}>
                      <Text
                        fontSize="xs"
                        fontWeight={isToday ? '700' : '500'}
                        color={isToday ? 'blue.700' : holiday ? 'red.600' : 'gray.600'}
                      >
                        {date.getDate()}
                      </Text>
                      {holiday && (
                        <Text fontSize="0.55rem" color="red.500" fontWeight="600">
                          OFF
                        </Text>
                      )}
                    </Flex>
                    {holiday && (
                      <Text fontSize="0.6rem" color="red.600" noOfLines={1} title={holiday.remark}>
                        {holiday.remark}
                      </Text>
                    )}
                    {dayItems.slice(0, CHIPS_PER_CELL).map((chip) => (
                      <DayChip
                        key={chip.key}
                        to={chip.to}
                        bg={chip.bg}
                        subject={chip.subject}
                        label={chip.label}
                        title={chip.tooltip}
                      />
                    ))}
                    {dayItems.length > CHIPS_PER_CELL && (
                      <Text
                        fontSize="0.6rem"
                        color="blue.600"
                        fontWeight="600"
                        mt={0.5}
                        _hover={{ textDecoration: 'underline' }}
                      >
                        +{dayItems.length - CHIPS_PER_CELL} more
                      </Text>
                    )}
                  </Box>
                );
              })}
            </Grid>
          </Box>

          <SectionCard title="Coursework this month">
            {data.coursework.length === 0 ? (
              <EmptyState icon="📅" title="No coursework this month" />
            ) : (
              data.coursework.map((item) => {
                const meta = courseworkMeta(item);
                return (
                  <Flex
                    key={item._id}
                    as={RouterLink}
                    to={courseworkLink(item)}
                    align="center"
                    gap={3}
                    py={2.5}
                    borderBottomWidth="1px"
                    borderColor="gray.100"
                    _hover={{ bg: 'gray.50', textDecoration: 'none' }}
                  >
                    <Text>{meta.icon}</Text>
                    <Box flex="1" minW={0}>
                      <Flex align="center" gap={2} minW={0}>
                        {subjectShort(item.class) && (
                          <Badge bg={item.class?.coverColor || 'gray.500'} color="white" fontSize="0.6rem">
                            {subjectShort(item.class)}
                          </Badge>
                        )}
                        <Text fontSize="sm" fontWeight="500" noOfLines={1}>
                          {item.title}
                        </Text>
                      </Flex>
                      <Text fontSize="xs" color="gray.500">
                        {item.class?.name} · {item.dateKind === 'posted' ? 'Posted' : 'Due'}{' '}
                        {formatDate(item.calendarDate || item.dueDate)}
                      </Text>
                    </Box>
                    {item.mySubmissionState && (
                      <Badge colorScheme={item.mySubmissionState === 'assigned' ? 'orange' : 'green'}>
                        {item.mySubmissionState === 'assigned' ? 'Not done' : item.mySubmissionState}
                      </Badge>
                    )}
                  </Flex>
                );
              })
            )}
          </SectionCard>

          <Box mt={5}>
            <SectionCard title="Quizzes this month">
              {data.quizzes.length === 0 ? (
                <EmptyState icon="🧠" title="No quizzes this month" />
              ) : (
                data.quizzes.map((quiz) => (
                  <Flex
                    key={quiz._id}
                    as={RouterLink}
                    to={`/learning/class/${quiz.classId}/quiz/${quiz._id}`}
                    align="center"
                    gap={3}
                    py={2.5}
                    borderBottomWidth="1px"
                    borderColor="gray.100"
                    _hover={{ bg: 'gray.50', textDecoration: 'none' }}
                  >
                    <Text>🧠</Text>
                    <Box flex="1" minW={0}>
                      <Flex align="center" gap={2} minW={0}>
                        {subjectShort(quiz.class) && (
                          <Badge bg="purple.500" color="white" fontSize="0.6rem">
                            {subjectShort(quiz.class)}
                          </Badge>
                        )}
                        <Text fontSize="sm" fontWeight="500" noOfLines={1}>
                          {quiz.title}
                        </Text>
                      </Flex>
                      <Text fontSize="xs" color="gray.500">
                        {quiz.class?.name} · {formatDateTime(quiz.conductedAt)}
                        {quiz.timeLimitMinutes ? ` · ${quiz.timeLimitMinutes} min` : ''}
                      </Text>
                    </Box>
                    {quiz.myAttemptStatus === 'submitted' ? (
                      <Badge colorScheme="green">
                        {quiz.myPercent === null ? 'Submitted' : `${quiz.myPercent}%`}
                      </Badge>
                    ) : (
                      quiz.myAttemptStatus && <Badge colorScheme="orange">{quiz.myAttemptStatus.replace('_', ' ')}</Badge>
                    )}
                  </Flex>
                ))
              )}
            </SectionCard>
          </Box>

          <Box mt={5}>
            <SectionCard title="Shorts presented this month">
              {data.shorts.length === 0 ? (
                <EmptyState icon="⚡" title="No Shorts were run this month" />
              ) : (
                data.shorts.map((short) => {
                  const reportPath = isTeacher(short.myRole)
                    ? `/learning/class/${short.classId}/short/${short.shortId}/report/${short._id}`
                    : null;
                  return (
                    <Flex
                      key={short._id}
                      {...(reportPath ? { as: RouterLink, to: reportPath } : {})}
                      align="center"
                      gap={3}
                      py={2.5}
                      borderBottomWidth="1px"
                      borderColor="gray.100"
                      _hover={reportPath ? { bg: 'gray.50', textDecoration: 'none' } : undefined}
                    >
                      <Text>⚡</Text>
                      <Box flex="1" minW={0}>
                        <Flex align="center" gap={2} minW={0}>
                          {subjectShort(short.class) && (
                            <Badge bg="teal.500" color="white" fontSize="0.6rem">
                              {subjectShort(short.class)}
                            </Badge>
                          )}
                          <Text fontSize="sm" fontWeight="500" noOfLines={1}>
                            {short.title}
                          </Text>
                        </Flex>
                        <Text fontSize="xs" color="gray.500">
                          {short.class?.name} · {formatDateTime(short.startedAt)}
                          {short.presentedByName ? ` · ${short.presentedByName}` : ''}
                        </Text>
                      </Box>
                      <Badge colorScheme={short.status === 'live' ? 'red' : 'gray'}>
                        {short.status === 'live' ? 'Live' : `${short.participantCount} joined`}
                      </Badge>
                    </Flex>
                  );
                })
              )}
            </SectionCard>
          </Box>

          <Box mt={5}>
            <SectionCard
              title="Non-working days"
              subtitle="From the attendance module's academic session calendar."
            >
              {data.nonWorkingDays.length === 0 ? (
                <EmptyState icon="🏖️" title="No holidays configured for this month" />
              ) : (
                data.nonWorkingDays.map((day) => (
                  <Flex key={day.date} align="center" gap={3} py={2.5} borderBottomWidth="1px" borderColor="gray.100">
                    <Text>🏖️</Text>
                    <Box flex="1" minW={0}>
                      <Text fontSize="sm" fontWeight="500" noOfLines={1}>
                        {day.remark}
                      </Text>
                      <Text fontSize="xs" color="gray.500">
                        {formatDate(parseDayKey(day.date))}
                        {day.session ? ` · ${day.session}` : ''}
                      </Text>
                    </Box>
                    <Badge colorScheme="red">Off</Badge>
                  </Flex>
                ))
              )}
            </SectionCard>
          </Box>

          <DayDetailModal
            date={selectedDay}
            items={selectedDay ? byDay.get(dayKey(selectedDay)) || [] : []}
            holiday={selectedDay ? holidayByDay.get(dayKey(selectedDay)) : null}
            onClose={() => setSelectedDay(null)}
          />
        </>
      )}
    </Box>
  );
}
