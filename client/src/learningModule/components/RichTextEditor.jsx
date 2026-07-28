import React, { useCallback, useMemo, useRef } from 'react';
import ReactQuill from 'react-quill';
import { Box, Button, HStack, Text, Tooltip } from '@chakra-ui/react';
import 'react-quill/dist/quill.snow.css';

/**
 * Rich text editor for every authoring surface in the learning module —
 * question stems, MCQ options, explanations, tutorial prompts, worked
 * solutions, announcements and assignment instructions.
 *
 * Uses react-quill because the quiz module already does, so students and staff
 * meet one editor across the platform rather than three. Output is HTML,
 * sanitised at render time by <RichText> (see the note there on why that is the
 * right boundary).
 *
 * `variables` turns on the placeholder bar used by parameterised tutorials: it
 * inserts `{{name}}` as *plain text* at the cursor, which matters because the
 * server substitutes those with a regex over the stored HTML. A placeholder
 * split by markup — `{{<strong>R</strong>}}` — would never match, so inserting
 * it via this button rather than by hand is the safe path (the server also
 * rejects a split placeholder with a clear message).
 */

const FULL_TOOLBAR = [
  [{ header: [2, 3, false] }],
  ['bold', 'italic', 'underline', 'strike'],
  [{ script: 'sub' }, { script: 'super' }],
  [{ list: 'ordered' }, { list: 'bullet' }],
  ['blockquote', 'code-block'],
  [{ color: [] }, { background: [] }],
  ['link', 'image'],
  ['clean'],
];

// Enough for a formula or a chemical symbol in an MCQ option, without a
// toolbar taller than the field itself.
const COMPACT_TOOLBAR = [
  ['bold', 'italic'],
  [{ script: 'sub' }, { script: 'super' }],
  ['link', 'image'],
  ['clean'],
];

export default function RichTextEditor({
  value,
  onChange,
  placeholder,
  compact = false,
  minH,
  variables = null,
  isInvalid = false,
}) {
  const quillRef = useRef(null);

  const modules = useMemo(
    () => ({
      toolbar: { container: compact ? COMPACT_TOOLBAR : FULL_TOOLBAR },
      clipboard: { matchVisual: false },
    }),
    [compact],
  );

  const insertVariable = useCallback((name) => {
    const editor = quillRef.current?.getEditor();
    if (!editor) return;
    const selection = editor.getSelection(true);
    const at = selection ? selection.index : editor.getLength();
    // insertText writes plain characters, so the braces cannot end up wrapped
    // in markup and break the server-side substitution.
    editor.insertText(at, `{{${name}}}`, 'user');
    editor.setSelection(at + name.length + 4, 0);
  }, []);

  return (
    <Box
      sx={{
        '.ql-toolbar': {
          borderTopRadius: 'md',
          borderColor: isInvalid ? 'red.300' : 'gray.200',
          bg: 'gray.50',
        },
        '.ql-container': {
          borderBottomRadius: 'md',
          borderColor: isInvalid ? 'red.300' : 'gray.200',
          fontFamily: 'inherit',
          fontSize: '0.95rem',
        },
        '.ql-editor': { minHeight: minH || (compact ? '70px' : '140px') },
        '.ql-editor.ql-blank::before': { fontStyle: 'normal', color: 'gray.400' },
        // Quill renders images at natural size, which blows out the layout for
        // a phone photo of a circuit diagram.
        '.ql-editor img': { maxWidth: '100%', height: 'auto' },
      }}
    >
      <ReactQuill
        ref={quillRef}
        theme="snow"
        value={value || ''}
        onChange={onChange}
        modules={modules}
        placeholder={placeholder}
      />

      {variables && (
        <HStack mt={2} spacing={2} wrap="wrap">
          <Text fontSize="xs" color="gray.500">
            Insert variable:
          </Text>
          {variables.filter(Boolean).length === 0 ? (
            <Text fontSize="xs" color="gray.400">
              declare one below first
            </Text>
          ) : (
            variables.filter(Boolean).map((name) => (
              <Tooltip key={name} label={`Insert {{${name}}} at the cursor`}>
                <Button size="xs" variant="outline" fontFamily="mono" onClick={() => insertVariable(name)}>
                  {`{{${name}}}`}
                </Button>
              </Tooltip>
            ))
          )}
        </HStack>
      )}
    </Box>
  );
}
