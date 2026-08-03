import React, { useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Image,
  Spinner,
  Text,
  useColorMode,
  useColorModeValue,
} from '@chakra-ui/react';
import {
  FiAlertCircle,
  FiArrowDown,
  FiArrowUp,
  FiCheckCircle,
  FiEdit2,
  FiEye,
  FiLock,
  FiPlay,
  FiSquare,
  FiTrash2,
} from 'react-icons/fi';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';

import HintTooltip from './HintTooltip';
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

/**
 * The output pane. Absent until there is something to put in it — "this cell is
 * running" is the gutter's job now, and saying it in both places produced two
 * spinners for one run.
 */
function OutputBlock({ outputs }) {
  const bg = useColorModeValue('gray.50', 'blackAlpha.400');
  const border = useColorModeValue('gray.200', 'whiteAlpha.200');

  if (!outputs || outputs.length === 0) return null;

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

/**
 * A markdown cell, read as prose rather than as source.
 *
 * It used to sit permanently open in the editor, so the explanation around an
 * exercise — the headings, the emphasis, the tables — arrived as a wall of `##`
 * and `**` that the reader had to render in their head. Prose is the point of
 * the cell; the source is the exception.
 *
 * Edit toggles back, and double-clicking the text does too, which is the
 * gesture Jupyter and Colab have trained everyone to expect.
 */
function MarkdownCell({ cell, index, total, locked, readOnly, onChange, onMove, onDelete }) {
  const { colorMode } = useColorMode();
  const border = useColorModeValue('gray.200', 'whiteAlpha.200');
  const gutter = useColorModeValue('gray.50', 'whiteAlpha.50');

  // A cell with nothing in it has nothing to show, and the only reason it
  // exists is that someone just added it to type into.
  const [editing, setEditing] = useState(() => !locked && !String(cell.source || '').trim());

  if (locked) {
    return (
      <Box borderWidth="1px" borderColor={border} borderRadius="md" overflow="hidden">
        <Box px={4} py={3}>
          <RichText markdown>{cell.source}</RichText>
        </Box>
      </Box>
    );
  }

  return (
    <Box borderWidth="1px" borderColor={border} borderRadius="md" overflow="hidden">
      <Flex align="center" gap={2} px={3} py={1} bg={gutter} borderBottomWidth="1px" borderColor={border}>
        <Badge fontSize="2xs">markdown</Badge>
        <Box flex="1" />
        <HintTooltip
          label={editing ? 'Show it the way it will be read' : 'Edit the Markdown source'}
        >
          <Button
            size="xs"
            variant="ghost"
            leftIcon={editing ? <FiEye /> : <FiEdit2 />}
            onClick={() => setEditing((current) => !current)}
          >
            {editing ? 'Done' : 'Edit'}
          </Button>
        </HintTooltip>
        <CellControls index={index} total={total} onMove={onMove} onDelete={onDelete} readOnly={readOnly} />
      </Flex>

      {editing ? (
        <CodeMirror
          value={cell.source}
          onChange={(source) => onChange({ source })}
          theme={colorMode === 'dark' ? 'dark' : 'light'}
          basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
          minHeight="60px"
        />
      ) : (
        <Box px={4} py={3} cursor="text" onDoubleClick={() => setEditing(true)}>
          <RichText
            markdown
            fallback={
              <Text fontSize="sm" opacity={0.5} fontStyle="italic">
                Empty — press Edit to write something.
              </Text>
            }
          >
            {cell.source}
          </RichText>
        </Box>
      )}
    </Box>
  );
}

/**
 * Whether the last run worked, in the cell's own gutter.
 *
 * Colab's green tick, and for the same reason: a cell that ends in an
 * assignment or a `def` displays nothing at all when it succeeds, which is
 * correct notebook behaviour and completely indistinguishable from a cell that
 * did not run. The `[n]` counter beside it is the Jupyter answer to that, but a
 * number going from blank to 1 is not something anyone notices.
 *
 * `running` wins over the stored result: a re-run clears the outputs before it
 * starts, so the previous tick would otherwise sit there through the new run.
 */
function CellStatus({ running, cell }) {
  if (running) {
    return (
      <HStack spacing={1.5} color="blue.400" flexShrink={0}>
        <Spinner size="xs" speed="0.7s" />
        <Text fontSize="xs" fontWeight="500">
          Running…
        </Text>
      </HStack>
    );
  }

  if (!cell.runCount) return null;

  const failed = (cell.outputs || []).some((output) => output.type === 'error');
  const at = cell.executedAt ? new Date(cell.executedAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? ` at ${at.toLocaleTimeString()}` : '';

  return (
    <HintTooltip
      label={
        failed
          ? `This cell finished with an error${when}`
          : `Ran without errors${when}. A cell that assigns or defines something shows no output — that is normal.`
      }
    >
      <Box as="span" display="inline-flex" color={failed ? 'red.400' : 'green.400'} fontSize="14px">
        {failed ? <FiAlertCircle aria-label="Finished with an error" /> : <FiCheckCircle aria-label="Ran successfully" />}
      </Box>
    </HintTooltip>
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
      <MarkdownCell
        cell={cell}
        index={index}
        total={total}
        locked={locked}
        readOnly={readOnly}
        onChange={onChange}
        onMove={onMove}
        onDelete={onDelete}
      />
    );
  }

  return (
    <Box borderWidth="1px" borderColor={border} borderRadius="md" overflow="hidden">
      <Flex align="center" gap={2} px={3} py={1} bg={gutter} borderBottomWidth="1px" borderColor={border}>
        <HintTooltip label={running ? 'Stop the kernel' : 'Run this cell'}>
          <IconButton
            aria-label={running ? 'Stop' : 'Run cell'}
            icon={running ? <FiSquare /> : <FiPlay />}
            size="xs"
            colorScheme={running ? 'red' : 'green'}
            variant={running ? 'solid' : 'ghost'}
            isDisabled={!canRun && !running}
            onClick={running ? onStop : onRun}
          />
        </HintTooltip>

        <Text fontSize="xs" fontFamily="mono" opacity={0.55} minW="42px">
          {/* The `In [n]` a notebook shows: how many times this cell has run,
              which is the quickest way to spot a cell you forgot to re-run. */}
          [{cell.runCount || ' '}]
        </Text>

        <CellStatus running={running} cell={cell} />

        {cell.locked && (
          <HintTooltip label="Set up by your teacher — you can run it but not change it">
            <Badge display="flex" alignItems="center" gap={1} fontSize="2xs">
              <FiLock /> locked
            </Badge>
          </HintTooltip>
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

      <OutputBlock outputs={cell.outputs} />
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
