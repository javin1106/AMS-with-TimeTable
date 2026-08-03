import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Box, Button, Flex, HStack, Input, SimpleGrid, Text } from '@chakra-ui/react';
import { evaluate, formatResult } from '../calculator';

/**
 * The on-screen scientific calculator offered during a sitting.
 *
 * It floats over the paper rather than sitting in the page flow, and it can be
 * dragged, because a fixed panel is guaranteed to cover the one question the
 * student is working on. It is deliberately self-contained — no clipboard, no
 * history that survives a reload, nothing that could carry an answer between
 * attempts — so a quiz that allows a calculator is not also allowing a notepad.
 *
 * Everything renders inside the quiz stage, so it stays visible in fullscreen;
 * a Chakra modal or popover would portal to `document.body` and vanish behind
 * the fullscreened stage (the same reason `QuizAttempt` renders its notices
 * inline rather than as toasts).
 */

const KEY_KINDS = {
  number: { bg: 'white', _hover: { bg: 'gray.100' }, color: 'gray.800' },
  function: { bg: 'purple.50', _hover: { bg: 'purple.100' }, color: 'purple.700' },
  operator: { bg: 'gray.100', _hover: { bg: 'gray.200' }, color: 'gray.800' },
  clear: { bg: 'orange.50', _hover: { bg: 'orange.100' }, color: 'orange.700' },
  equals: { bg: 'purple.500', _hover: { bg: 'purple.600' }, color: 'white' },
};

// label, what it types, how it is coloured, and how a screen reader says it.
const key = (label, insert, kind = 'number', aria) => ({ label, insert, kind, aria });
const action = (label, act, kind, aria) => ({ label, action: act, kind, aria });

const ROWS = [
  [
    key('sin', 'sin(', 'function', 'sine'),
    key('cos', 'cos(', 'function', 'cosine'),
    key('tan', 'tan(', 'function', 'tangent'),
    key('ln', 'ln(', 'function', 'natural logarithm'),
    key('log', 'log(', 'function', 'logarithm base 10'),
  ],
  [
    key('sin⁻¹', 'asin(', 'function', 'inverse sine'),
    key('cos⁻¹', 'acos(', 'function', 'inverse cosine'),
    key('tan⁻¹', 'atan(', 'function', 'inverse tangent'),
    key('π', 'π', 'function', 'pi'),
    key('e', 'e', 'function', "Euler's number"),
  ],
  [
    key('(', '(', 'operator', 'open bracket'),
    key(')', ')', 'operator', 'close bracket'),
    key('xʸ', '^', 'operator', 'to the power of'),
    key('√', '√(', 'function', 'square root'),
    key('x!', '!', 'function', 'factorial'),
  ],
  [
    key('7', '7'),
    key('8', '8'),
    key('9', '9'),
    key('÷', '÷', 'operator', 'divide'),
    action('⌫', 'backspace', 'clear', 'backspace'),
  ],
  [
    key('4', '4'),
    key('5', '5'),
    key('6', '6'),
    key('×', '×', 'operator', 'multiply'),
    action('C', 'clear', 'clear', 'clear'),
  ],
  [
    key('1', '1'),
    key('2', '2'),
    key('3', '3'),
    key('−', '−', 'operator', 'minus'),
    key('Ans', 'Ans', 'function', 'previous answer'),
  ],
  [
    key('0', '0'),
    key('.', '.', 'number', 'decimal point'),
    key('%', '%', 'operator', 'percent'),
    key('+', '+', 'operator', 'plus'),
    action('=', 'equals', 'equals', 'equals'),
  ],
];

const PANEL_WIDTH = 300;

export default function QuizCalculator() {
  const [open, setOpen] = useState(false);
  const [expression, setExpression] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [degrees, setDegrees] = useState(true);
  const [ans, setAns] = useState(0);
  const [memory, setMemory] = useState(0);
  // Null until the panel is first dragged, so it opens pinned to the corner and
  // only then starts carrying explicit coordinates.
  const [position, setPosition] = useState(null);

  const inputRef = useRef(null);
  const panelRef = useRef(null);
  const dragRef = useRef(null);

  /* ------------------------------ editing ------------------------------ */

  /** Types at the caret, not at the end — the display is editable. */
  const insert = useCallback((text) => {
    setError(null);
    setResult(null);
    const field = inputRef.current;
    if (!field) {
      setExpression((prev) => prev + text);
      return;
    }
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    setExpression(field.value.slice(0, start) + text + field.value.slice(end));
    // The caret can only be placed once React has written the new value.
    requestAnimationFrame(() => {
      field.focus();
      const caret = start + text.length;
      field.setSelectionRange(caret, caret);
    });
  }, []);

  const backspace = useCallback(() => {
    setError(null);
    setResult(null);
    const field = inputRef.current;
    if (!field) {
      setExpression((prev) => prev.slice(0, -1));
      return;
    }
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    const from = start === end ? Math.max(0, start - 1) : start;
    setExpression(field.value.slice(0, from) + field.value.slice(end));
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(from, from);
    });
  }, []);

  /* ----------------------------- computing ----------------------------- */

  const evaluateNow = useCallback((text) => evaluate(text, { degrees, ans }), [degrees, ans]);

  // Shown greyed under the expression while it is still being typed, so a
  // mistyped bracket is obvious before pressing equals.
  const preview = useMemo(() => {
    if (!expression.trim()) return null;
    try {
      return formatResult(evaluateNow(expression));
    } catch {
      return null;
    }
  }, [expression, evaluateNow]);

  const compute = useCallback(() => {
    if (!expression.trim()) return null;
    try {
      const value = evaluateNow(expression);
      setAns(value);
      setResult(formatResult(value));
      setError(null);
      return value;
    } catch (err) {
      setResult(null);
      setError(err.message);
      return null;
    }
  }, [expression, evaluateNow]);

  const clearAll = useCallback(() => {
    setExpression('');
    setResult(null);
    setError(null);
    inputRef.current?.focus();
  }, []);

  const onKey = useCallback(
    (button) => {
      if (button.insert !== undefined) {
        insert(button.insert);
        return;
      }
      if (button.action === 'equals') compute();
      else if (button.action === 'clear') clearAll();
      else if (button.action === 'backspace') backspace();
    },
    [insert, compute, clearAll, backspace],
  );

  /** Memory keys work on whatever is on screen — the result, or Ans if blank. */
  const memoryValue = useCallback(() => {
    if (!expression.trim()) return ans;
    try {
      return evaluateNow(expression);
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, [expression, ans, evaluateNow]);

  /* ------------------------------ dragging ----------------------------- */

  const startDrag = useCallback((event) => {
    const panel = panelRef.current;
    // The title bar carries buttons too; pressing one is not a drag.
    if (!panel || event.button !== 0 || event.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    // The first move switches the panel from corner-pinned to coordinates.
    setPosition({ left: rect.left, top: rect.top });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  const onDrag = useCallback((event) => {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || !panel) return;
    const rect = panel.getBoundingClientRect();
    // Clamped so the panel can never be parked off-screen, where a student in
    // fullscreen would have no scrollbar to chase it with.
    setPosition({
      left: Math.min(Math.max(0, event.clientX - drag.dx), window.innerWidth - rect.width),
      top: Math.min(Math.max(0, event.clientY - drag.dy), window.innerHeight - rect.height),
    });
  }, []);

  const endDrag = useCallback((event) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  /* ------------------------------- render ------------------------------ */

  if (!open) {
    return (
      <Button
        position="fixed"
        bottom="16px"
        right="16px"
        zIndex={20}
        size="sm"
        colorScheme="purple"
        boxShadow="lg"
        leftIcon={<span aria-hidden="true">🖩</span>}
        onClick={() => setOpen(true)}
      >
        Calculator
      </Button>
    );
  }

  return (
    <Box
      ref={panelRef}
      role="dialog"
      aria-label="Scientific calculator"
      position="fixed"
      zIndex={20}
      {...(position
        ? { left: `${position.left}px`, top: `${position.top}px` }
        : { right: '16px', bottom: '16px' })}
      w={`min(${PANEL_WIDTH}px, calc(100vw - 24px))`}
      bg="white"
      borderWidth="1px"
      borderColor="gray.300"
      borderRadius="lg"
      boxShadow="2xl"
      overflow="hidden"
      // The paper disables selection when copy/paste is off; the calculator's
      // own display still has to be usable.
      userSelect="text"
    >
      {/* ---- title bar, and the drag handle ---- */}
      <Flex
        align="center"
        gap={2}
        px={3}
        py={2}
        bg="gray.50"
        borderBottomWidth="1px"
        borderColor="gray.200"
        cursor="grab"
        _active={{ cursor: 'grabbing' }}
        sx={{ touchAction: 'none' }}
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <Text fontSize="sm" fontWeight="700" color="gray.700">
          🖩 Calculator
        </Text>
        <Box flex="1" />
        <Button
          size="xs"
          variant={degrees ? 'solid' : 'outline'}
          colorScheme="purple"
          onClick={() => {
            setDegrees((on) => !on);
            // The result goes with the mode: a figure worked out in degrees
            // must not sit on screen under a RAD label.
            setResult(null);
          }}
          aria-label={`Angles in ${degrees ? 'degrees' : 'radians'}, switch to ${degrees ? 'radians' : 'degrees'}`}
        >
          {degrees ? 'DEG' : 'RAD'}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setOpen(false)} aria-label="Close the calculator">
          ✕
        </Button>
      </Flex>

      {/* ---- display ---- */}
      <Box px={3} pt={3} pb={2}>
        <Input
          ref={inputRef}
          value={expression}
          onChange={(event) => {
            setExpression(event.target.value);
            setError(null);
            setResult(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              compute();
            }
          }}
          placeholder="0"
          size="sm"
          textAlign="right"
          fontFamily="mono"
          fontSize="md"
          borderColor={error ? 'red.300' : 'gray.200'}
          aria-label="Calculation"
          spellCheck={false}
          autoComplete="off"
        />
        <Flex justify="flex-end" align="baseline" minH="28px" mt={1} gap={2}>
          {error ? (
            <Text fontSize="xs" color="red.500" textAlign="right">
              {error}
            </Text>
          ) : (
            <>
              {memory !== 0 && (
                <Text fontSize="xs" color="gray.400" mr="auto" title={`Memory: ${formatResult(memory)}`}>
                  M
                </Text>
              )}
              <Text
                fontFamily="mono"
                fontWeight={result ? '700' : '400'}
                fontSize={result ? 'xl' : 'sm'}
                color={result ? 'gray.800' : 'gray.400'}
                lineHeight="1.2"
                noOfLines={1}
              >
                {result ?? (preview !== null ? `= ${preview}` : '')}
              </Text>
            </>
          )}
        </Flex>
      </Box>

      {/* ---- memory ---- */}
      <HStack px={3} pb={2} spacing={1}>
        {[
          ['MC', () => setMemory(0), 'clear memory'],
          ['MR', () => insert(formatResult(memory)), 'recall memory'],
          [
            'M+',
            () => {
              const value = memoryValue();
              if (value !== null) setMemory((held) => held + value);
            },
            'add to memory',
          ],
          [
            'M−',
            () => {
              const value = memoryValue();
              if (value !== null) setMemory((held) => held - value);
            },
            'subtract from memory',
          ],
        ].map(([label, onClick, aria]) => (
          <Button key={label} size="xs" flex="1" variant="ghost" color="gray.600" onClick={onClick} aria-label={aria}>
            {label}
          </Button>
        ))}
      </HStack>

      {/* ---- keypad ---- */}
      <SimpleGrid columns={5} spacing="4px" px={3} pb={3}>
        {ROWS.flat().map((button) => (
          <Button
            key={button.label}
            size="sm"
            h="36px"
            px={0}
            fontSize={button.label.length > 3 ? 'xs' : 'sm'}
            fontWeight="600"
            borderWidth={button.kind === 'equals' ? 0 : '1px'}
            borderColor="gray.200"
            aria-label={button.aria || button.label}
            onClick={() => onKey(button)}
            {...KEY_KINDS[button.kind || 'number']}
          >
            {button.label}
          </Button>
        ))}
      </SimpleGrid>
    </Box>
  );
}
