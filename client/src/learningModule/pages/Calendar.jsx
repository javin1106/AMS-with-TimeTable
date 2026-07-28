import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Badge, Box, Button, Flex, Grid, HStack, Heading, Text } from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading, SectionCard } from '../components/common';
import { WORK_TYPE_META, formatDate } from '../format';

const startOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1);
const endOfMonth = (date) => new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);
const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function Calendar() {
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(
        await lmApi.calendar({
          from: startOfMonth(cursor).toISOString(),
          to: endOfMonth(cursor).toISOString(),
        }),
      );
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

  const byDay = useMemo(() => {
    const map = new Map();
    items.forEach((item) => {
      const key = new Date(item.dueDate).toDateString();
      map.set(key, [...(map.get(key) || []), item]);
    });
    return map;
  }, [items]);

  const today = new Date();

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={4} gap={3} wrap="wrap">
        <Box>
          <Heading size="lg">Calendar</Heading>
          <Text color="gray.500" fontSize="sm">
            Due dates across all your classes.
          </Text>
        </Box>
        <HStack>
          <Button size="sm" variant="outline" onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}>
            ←
          </Button>
          <Text fontWeight="600" minW="160px" textAlign="center">
            {cursor.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
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
          <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={3} mb={5} overflowX="auto">
            <Grid templateColumns="repeat(7, minmax(90px, 1fr))" gap={1} minW="640px">
              {WEEKDAYS.map((day) => (
                <Text key={day} fontSize="xs" fontWeight="600" color="gray.500" textAlign="center" py={1}>
                  {day}
                </Text>
              ))}
              {cells.map((date, index) => {
                if (!date) return <Box key={`pad-${index}`} />;
                const dayItems = byDay.get(date.toDateString()) || [];
                const isToday = sameDay(date, today);
                return (
                  <Box
                    key={date.toISOString()}
                    minH="86px"
                    borderWidth="1px"
                    borderColor={isToday ? 'blue.400' : 'gray.100'}
                    bg={isToday ? 'blue.50' : 'white'}
                    borderRadius="md"
                    p={1.5}
                  >
                    <Text fontSize="xs" fontWeight={isToday ? '700' : '500'} color={isToday ? 'blue.700' : 'gray.600'}>
                      {date.getDate()}
                    </Text>
                    {dayItems.slice(0, 3).map((item) => (
                      <Box
                        key={item._id}
                        as={RouterLink}
                        to={`/learning/class/${item.classId}/work/${item._id}`}
                        display="block"
                        mt={1}
                        px={1}
                        py={0.5}
                        borderRadius="sm"
                        bg={item.class?.coverColor || 'gray.400'}
                        color="white"
                        fontSize="0.65rem"
                        noOfLines={1}
                        _hover={{ opacity: 0.85, textDecoration: 'none' }}
                        title={item.title}
                      >
                        {item.title}
                      </Box>
                    ))}
                    {dayItems.length > 3 && (
                      <Text fontSize="0.6rem" color="gray.500" mt={0.5}>
                        +{dayItems.length - 3} more
                      </Text>
                    )}
                  </Box>
                );
              })}
            </Grid>
          </Box>

          <SectionCard title="This month's deadlines">
            {items.length === 0 ? (
              <EmptyState icon="📅" title="Nothing due this month" />
            ) : (
              items.map((item) => {
                const meta = WORK_TYPE_META[item.workType] || WORK_TYPE_META.assignment;
                return (
                  <Flex
                    key={item._id}
                    as={RouterLink}
                    to={`/learning/class/${item.classId}/work/${item._id}`}
                    align="center"
                    gap={3}
                    py={2.5}
                    borderBottomWidth="1px"
                    borderColor="gray.100"
                    _hover={{ bg: 'gray.50', textDecoration: 'none' }}
                  >
                    <Text>{meta.icon}</Text>
                    <Box flex="1" minW={0}>
                      <Text fontSize="sm" fontWeight="500" noOfLines={1}>
                        {item.title}
                      </Text>
                      <Text fontSize="xs" color="gray.500">
                        {item.class?.name} · {formatDate(item.dueDate)}
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
        </>
      )}
    </Box>
  );
}
