import React, { useRef, useState } from 'react';
import {
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Input,
  Link,
  Text,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';

const ICONS = { file: '📎', link: '🔗', video: '🎬', audio: '🎧', note: '📝' };

const prettySize = (bytes) => {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
};

/** Read-only chip list of a post's attachments. */
export function AttachmentList({ attachments = [], compact = false }) {
  if (!attachments.length) return null;
  return (
    <Flex wrap="wrap" gap={2} mt={compact ? 1 : 3}>
      {attachments.map((attachment, index) => (
        <Link
          key={attachment._id || `${attachment.url}-${index}`}
          href={attachment.kind === 'link' ? attachment.url : lmApi.fileUrl(attachment.url)}
          isExternal
          _hover={{ textDecoration: 'none', borderColor: 'blue.400' }}
        >
          <Flex
            align="center"
            gap={2}
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="md"
            px={3}
            py={compact ? 1 : 2}
            bg="gray.50"
            maxW="280px"
          >
            <Text>{ICONS[attachment.kind] || '📎'}</Text>
            <Box overflow="hidden">
              <Text fontSize="sm" noOfLines={1} color="blue.700">
                {attachment.name || attachment.url}
              </Text>
              {attachment.sizeBytes ? (
                <Text fontSize="xs" color="gray.500">
                  {prettySize(attachment.sizeBytes)}
                </Text>
              ) : null}
            </Box>
          </Flex>
        </Link>
      ))}
    </Flex>
  );
}

/**
 * Attachment picker used by every composer (announcement, assignment,
 * submission). Uploads immediately and hands the caller a stable attachment
 * array so the parent form only ever deals with metadata.
 */
export function AttachmentPicker({ attachments = [], onChange, disabled }) {
  const fileInput = useRef(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const toast = useToast();

  const handleFiles = async (event) => {
    const { files } = event.target;
    if (!files?.length) return;
    setUploading(true);
    try {
      const result = await lmApi.uploadFiles(files);
      onChange([...attachments, ...result.attachments]);
    } catch (error) {
      toast({ status: 'error', title: 'Upload failed', description: error.message });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  // Committed on Enter, on the Add button and on blur — a URL left sitting in
  // the box used to be thrown away when the composer was saved.
  const addLink = () => {
    const url = linkUrl.trim();
    if (!url) return;
    const normalised = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    onChange([...attachments, { kind: 'link', name: normalised, url: normalised }]);
    setLinkUrl('');
  };

  const remove = (index) => onChange(attachments.filter((_, i) => i !== index));

  return (
    <Box>
      <HStack spacing={2} wrap="wrap">
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileInput.current?.click()}
          isLoading={uploading}
          isDisabled={disabled}
          leftIcon={<span>📎</span>}
        >
          Attach files
        </Button>
        <Input
          size="sm"
          placeholder="Paste a link"
          value={linkUrl}
          maxW="280px"
          isDisabled={disabled}
          onChange={(event) => setLinkUrl(event.target.value)}
          onBlur={addLink}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addLink();
            }
          }}
        />
        <Button size="sm" variant="outline" onClick={addLink} isDisabled={disabled || !linkUrl.trim()}>
          Add link
        </Button>
      </HStack>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={handleFiles}
        aria-label="Attach files"
      />

      {attachments.length > 0 && (
        <Flex wrap="wrap" gap={2} mt={3}>
          {attachments.map((attachment, index) => (
            <Flex
              key={attachment._id || `${attachment.url}-${index}`}
              align="center"
              gap={2}
              borderWidth="1px"
              borderColor="gray.200"
              borderRadius="md"
              px={3}
              py={1}
              bg="white"
            >
              <Text fontSize="sm">{ICONS[attachment.kind] || '📎'}</Text>
              <Text fontSize="sm" noOfLines={1} maxW="200px">
                {attachment.name}
              </Text>
              <IconButton
                size="xs"
                variant="ghost"
                aria-label="Remove attachment"
                icon={<span>✕</span>}
                onClick={() => remove(index)}
                isDisabled={disabled}
              />
            </Flex>
          ))}
        </Flex>
      )}
    </Box>
  );
}
