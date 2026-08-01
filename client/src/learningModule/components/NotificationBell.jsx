import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
  Divider,
  Flex,
  IconButton,
  Popover,
  PopoverArrow,
  PopoverBody,
  PopoverContent,
  PopoverHeader,
  PopoverTrigger,
  Text,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { relativeTime } from '../format';

const POLL_MS = 60000;

const TYPE_ICONS = {
  announcement: '📣',
  coursework: '📄',
  comment: '💬',
  grade: '💯',
  submission: '📥',
  invite: '✉️',
  join_request: '🙋',
  quiz: '🧠',
  material: '📚',
  feedback: '🕊️',
};

export default function NotificationBell() {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const data = await lmApi.notifications({ limit: 10 });
      setItems(data.items);
      setUnread(data.unreadCount);
    } catch {
      // A polling failure is not worth surfacing — the next tick retries.
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const open = async (notification) => {
    await lmApi.markNotificationsRead([notification._id]).catch(() => {});
    setUnread((count) => Math.max(0, count - (notification.read ? 0 : 1)));
    setItems((prev) => prev.map((n) => (n._id === notification._id ? { ...n, read: true } : n)));
    if (notification.link) navigate(notification.link);
  };

  const markAll = async () => {
    await lmApi.markNotificationsRead().catch(() => {});
    setUnread(0);
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  return (
    <Popover placement="bottom-end" onOpen={load}>
      <PopoverTrigger>
        <Box position="relative" display="inline-block">
          <IconButton variant="ghost" aria-label="Notifications" icon={<span>🔔</span>} />
          {unread > 0 && (
            <Badge
              position="absolute"
              top="0"
              right="0"
              colorScheme="red"
              borderRadius="full"
              fontSize="0.6rem"
              px={1.5}
              pointerEvents="none"
            >
              {unread > 9 ? '9+' : unread}
            </Badge>
          )}
        </Box>
      </PopoverTrigger>
      <PopoverContent w="360px" maxW="90vw">
        <PopoverArrow />
        <PopoverHeader>
          <Flex justify="space-between" align="center">
            <Text fontWeight="600" fontSize="sm">
              Notifications
            </Text>
            {unread > 0 && (
              <Button size="xs" variant="link" colorScheme="blue" onClick={markAll}>
                Mark all read
              </Button>
            )}
          </Flex>
        </PopoverHeader>
        <PopoverBody px={0} maxH="420px" overflowY="auto">
          {items.length === 0 && (
            <Text px={4} py={6} fontSize="sm" color="gray.500" textAlign="center">
              Nothing new.
            </Text>
          )}
          {items.map((notification, index) => (
            <Box key={notification._id}>
              {index > 0 && <Divider />}
              <Flex
                as="button"
                w="100%"
                textAlign="left"
                px={4}
                py={3}
                gap={3}
                bg={notification.read ? 'transparent' : 'blue.50'}
                _hover={{ bg: 'gray.50' }}
                onClick={() => open(notification)}
              >
                <Text>{TYPE_ICONS[notification.type] || '🔔'}</Text>
                <Box flex="1" minW={0}>
                  <Text fontSize="sm" fontWeight={notification.read ? '400' : '600'} noOfLines={2}>
                    {notification.title}
                  </Text>
                  {notification.body && (
                    <Text fontSize="xs" color="gray.600" noOfLines={2}>
                      {notification.body}
                    </Text>
                  )}
                  <Text fontSize="xs" color="gray.400" mt={0.5}>
                    {relativeTime(notification.created_at)}
                  </Text>
                </Box>
              </Flex>
            </Box>
          ))}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}
