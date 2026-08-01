import React, { useEffect, useState } from 'react';
import {
  Button,
  FormControl,
  FormLabel,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Select,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { AttachmentPicker } from './Attachments';
import RichTextEditor from './RichTextEditor';

// Material is reading material and nothing else. Assessed work lives on its own
// tabs — Quizzes, Shorts, Tutorials — each of which owns its own editor, so
// there is no work-type picker here and nothing to grade.
const BLANK = {
  title: '',
  instructions: '',
  topicId: '',
  draft: false,
  scheduledFor: '',
};

/** Composer for material posts, shared by the Material tab and the detail page. */
export default function MaterialModal({ isOpen, onClose, classId, topics = [], onSaved, initial }) {
  const [form, setForm] = useState(BLANK);
  const [attachments, setAttachments] = useState([]);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!isOpen) return;
    if (initial) {
      setForm({ ...BLANK, ...initial, topicId: initial.topicId || '' });
      setAttachments(initial.attachments || []);
    } else {
      setForm(BLANK);
      setAttachments([]);
    }
  }, [isOpen, initial]);

  const set = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const save = async (asDraft) => {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      const payload = {
        workType: 'material',
        title: form.title,
        instructions: form.instructions,
        attachments,
        topicId: form.topicId || null,
        scheduledFor: form.scheduledFor || undefined,
        draft: asDraft,
        // Material is never assessed, so it carries no points and no deadline.
        graded: false,
        points: 0,
        dueDate: null,
      };
      if (initial) await lmApi.updateCoursework(classId, initial._id, payload);
      else await lmApi.createCoursework(classId, payload);
      onSaved();
      onClose();
    } catch (error) {
      toast({ status: 'error', title: 'Could not save', description: error.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>{initial ? 'Edit material' : 'New material'}</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <FormControl isRequired mb={4}>
            <FormLabel fontSize="sm">Title</FormLabel>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)} autoFocus />
          </FormControl>

          <FormControl mb={4}>
            <FormLabel fontSize="sm">Content</FormLabel>
            <RichTextEditor
              value={form.instructions}
              onChange={(html) => set('instructions', html)}
              minH="260px"
              placeholder="Reading material, notes, links…"
            />
          </FormControl>

          <FormControl mb={4} maxW="320px">
            <FormLabel fontSize="sm">Topic</FormLabel>
            <Select value={form.topicId} onChange={(e) => set('topicId', e.target.value)}>
              <option value="">No topic</option>
              {topics.map((topic) => (
                <option key={topic._id} value={topic._id}>
                  {topic.name}
                </option>
              ))}
            </Select>
          </FormControl>

          <AttachmentPicker attachments={attachments} onChange={setAttachments} disabled={saving} />

          {!initial && (
            <FormControl mt={4}>
              <FormLabel fontSize="sm">Schedule for later (optional)</FormLabel>
              <Input
                type="datetime-local"
                maxW="260px"
                value={form.scheduledFor}
                onChange={(e) => set('scheduledFor', e.target.value)}
              />
            </FormControl>
          )}
        </ModalBody>
        <ModalFooter gap={2}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {!initial && (
            <Button variant="outline" onClick={() => save(true)} isDisabled={!form.title.trim() || saving}>
              Save draft
            </Button>
          )}
          <Button
            colorScheme="blue"
            onClick={() => save(false)}
            isLoading={saving}
            isDisabled={!form.title.trim()}
          >
            {initial ? 'Save changes' : form.scheduledFor ? 'Schedule' : 'Post'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
