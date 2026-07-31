import React, { useMemo } from 'react';
import {
  Badge,
  Box,
  Flex,
  HStack,
  IconButton,
  Image,
  Spinner,
  Text,
  Tooltip,
  useColorMode,
  useColorModeValue,
} from '@chakra-ui/react';
import { FiArrowDown, FiArrowUp, FiLock, FiPlay, FiSquare, FiTrash2 } from 'react-icons/fi';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';

import RichText from './RichText';

/**
 * One notebook cell: source on top, output underneath.
 *
 * The output pane is deliberately *below* the editor rather than beside it,
 * despite the "code on one side, output on the other" framing. Side-by-side
 * halves the width available to both, and Python output is overwhelmingly wide
 * — a pandas DataFrame or a traceback wraps into unreadable soup at half a
 * screen. Stacked also survives a phone, which a split pane does not.
 */

/** stderr and tracebacks read as errors; everything else is plain output. */
const OUTPUT_COLOUR = {
  stderr: 'red.400',
  error: 'red.400',
  result: 'inherit',
  stdout: 'inherit',
};

function OutputBlock({ outputs, running }) {
  const bg = useColorModeValue('gray.50', 'blackAlpha.400');
  const border = useColorModeValue('gray.200', 'whiteAlpha.200');

  if (!running && (!outputs || outputs.length === 0)) return null;

  return (
    <Box
      bg={bg}
      borderTopWidth="1px"
      borderColor={border}
      px={4}
      py={3}
      fontSize="sm"
      maxH="480px"
      overflowY="auto"
      // Wide output scrolls inside the cell rather than stretching the page.
      overflowX="auto"
    >
      {running && (
        <HStack spacing={2} mb={outputs?.length ? 2 : 0} opacity={0.7}>
          <Spinner size="xs" />
          <Text fontSize="xs">Running…</Text>
        </HStack>
      )}

      {(outputs || []).map((output, index) =>
        output.type === 'image' ? (
          <Image
            key={index}
            src={`data:image/png;base64,${output.text}`}
            alt="Figure produced by this cell"
            maxW="100%"
            my={2}
          />
        ) : (
          <Box
            key={index}
            as="pre"
            fontFamily="mono"
            fontSize="13px"
            lineHeight="1.5"
            whiteSpace="pre-wrap"
            wordBreak="break-word"
            color={OUTPUT_COLOUR[output.type] || 'inherit'}
            // The repr of the last expression is the notebook's "return value";
            // italics distinguish it from something the code printed itself.
            fontStyle={output.type === 'result' ? 'italic' : 'normal'}
            m={0}
          >
            {output.text}
          </Box>
        ),
      )}
    </Box>
  );
}

export default function NotebookCell({
  cell,
  index,
  total,
  readOnly = false,
  running = false,
  canRun = true,
  onChange,
  onRun,
  onStop,
  onMove,
  onDelete,
}) {
  const { colorMode } = useColorMode();
  const border = useColorModeValue('gray.200', 'whiteAlpha.200');
  const gutter = useColorModeValue('gray.50', 'whiteAlpha.50');

  const extensions = useMemo(() => [python()], []);
  const locked = cell.locked || readOnly;

  if (cell.type === 'markdown') {
    return (
      <Box borderWidth="1px" borderColor={border} borderRadius="md" overflow="hidden">
        {locked ? (
          <Box px={4} py={3}>
            <RichText>{cell.source}</RichText>
          </Box>
        ) : (
          <>
            <Flex align="center" gap={2} px={3} py={1} bg={gutter} borderBottomWidth="1px" borderColor={border}>
              <Badge fontSize="2xs">markdown</Badge>
              <Box flex="1" />
              <CellControls
                index={index}
                total={total}
                onMove={onMove}
                onDelete={onDelete}
                readOnly={readOnly}
              />
            </Flex>
            <CodeMirror
              value={cell.source}
              onChange={(source) => onChange({ source })}
              theme={colorMode === 'dark' ? 'dark' : 'light'}
              basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
              minHeight="60px"
            />
          </>
        )}
      </Box>
    );
  }

  return (
    <Box borderWidth="1px" borderColor={border} borderRadius="md" overflow="hidden">
      <Flex align="center" gap={2} px={3} py={1} bg={gutter} borderBottomWidth="1px" borderColor={border}>
        <Tooltip label={running ? 'Stop the kernel' : 'Run this cell'}>
          <IconButton
            aria-label={running ? 'Stop' : 'Run cell'}
            icon={running ? <FiSquare /> : <FiPlay />}
            size="xs"
            colorScheme={running ? 'red' : 'green'}
            variant={running ? 'solid' : 'ghost'}
            isDisabled={!canRun && !running}
            onClick={running ? onStop : onRun}
          />
        </Tooltip>

        <Text fontSize="xs" fontFamily="mono" opacity={0.55} minW="42px">
          {/* The `In [n]` a notebook shows: how many times this cell has run,
              which is the quickest way to spot a cell you forgot to re-run. */}
          [{cell.runCount || ' '}]
        </Text>

        {cell.locked && (
          <Tooltip label="Set up by your teacher — you can run it but not change it">
            <Badge display="flex" alignItems="center" gap={1} fontSize="2xs">
              <FiLock /> locked
            </Badge>
          </Tooltip>
        )}

        <Box flex="1" />
        <CellControls index={index} total={total} onMove={onMove} onDelete={onDelete} readOnly={readOnly || cell.locked} />
      </Flex>

      <CodeMirror
        value={cell.source}
        onChange={(source) => onChange({ source })}
        theme={colorMode === 'dark' ? 'dark' : 'light'}
        extensions={extensions}
        editable={!locked}
        basicSetup={{ lineNumbers: true, foldGutter: false, autocompletion: false }}
        minHeight="72px"
      />

      <OutputBlock outputs={cell.outputs} running={running} />
    </Box>
  );
}

function CellControls({ index, total, onMove, onDelete, readOnly }) {
  if (readOnly) return null;
  return (
    <HStack spacing={0}>
      <IconButton
        aria-label="Move cell up"
        icon={<FiArrowUp />}
        size="xs"
        variant="ghost"
        isDisabled={index === 0}
        onClick={() => onMove(-1)}
      />
      <IconButton
        aria-label="Move cell down"
        icon={<FiArrowDown />}
        size="xs"
        variant="ghost"
        isDisabled={index === total - 1}
        onClick={() => onMove(1)}
      />
      <IconButton
        aria-label="Delete cell"
        icon={<FiTrash2 />}
        size="xs"
        variant="ghost"
        colorScheme="red"
        onClick={onDelete}
      />
    </HStack>
  );
}
