import React, { useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import {
  Box,
  Button,
  Checkbox,
  Divider,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Select,
  SimpleGrid,
  Text,
  Textarea,
  useClipboard,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { ClassCardPreview, ColorPicker, SectionCard } from '../components/common';
import { CLASS_COLORS } from '../format';

export default function ClassSettings() {
  const { classId, klass, reloadClass } = useOutletContext();
  const navigate = useNavigate();
  const toast = useToast();

  const [form, setForm] = useState({
    name: klass.name,
    section: klass.section,
    subject: klass.subject,
    subjectCode: klass.subjectCode,
    room: klass.room,
    description: klass.description,
    coverColor: klass.coverColor,
    meetLink: klass.meetLink,
    academicYear: klass.academicYear,
    semester: klass.semester,
    batch: klass.batch,
  });
  const [settings, setSettings] = useState({ ...klass.settings });
  const [code, setCode] = useState(klass.code);
  const [saving, setSaving] = useState(false);
  const { onCopy, hasCopied } = useClipboard(code);

  const set = (field) => (event) => setForm((prev) => ({ ...prev, [field]: event.target.value }));
  const setSetting = (field, value) => setSettings((prev) => ({ ...prev, [field]: value }));

  const save = async () => {
    setSaving(true);
    try {
      await lmApi.updateClass(classId, { ...form, settings });
      toast({ status: 'success', title: 'Class updated' });
      reloadClass();
    } catch (error) {
      toast({ status: 'error', title: error.message });
    } finally {
      setSaving(false);
    }
  };

  const regenerate = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Generate a new class code? The old one stops working immediately.')) return;
    try {
      const result = await lmApi.regenerateCode(classId);
      setCode(result.code);
      reloadClass();
      toast({ status: 'success', title: 'New class code generated' });
    } catch (error) {
      toast({ status: 'error', title: error.message });
    }
  };

  const archive = async () => {
    const archiving = klass.status !== 'archived';
    try {
      await lmApi.archiveClass(classId, archiving);
      toast({ status: 'success', title: archiving ? 'Class archived' : 'Class restored' });
      reloadClass();
    } catch (error) {
      toast({ status: 'error', title: error.message });
    }
  };

  const destroy = async () => {
    // eslint-disable-next-line no-alert
    const typed = window.prompt(`This permanently deletes "${klass.name}" with all its posts, work, grades and generated material. Type the class name to confirm.`);
    if (typed !== klass.name) return;
    try {
      await lmApi.deleteClass(classId);
      toast({ status: 'success', title: 'Class deleted' });
      navigate('/learning');
    } catch (error) {
      toast({ status: 'error', title: error.message });
    }
  };

  return (
    <Box maxW="820px">
      <SectionCard title="Class details" mb={4}>
        <FormControl mb={4}>
          <FormLabel fontSize="sm">Class name</FormLabel>
          <Input value={form.name} onChange={set('name')} />
        </FormControl>
        <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={4} mb={4}>
          <FormControl>
            <FormLabel fontSize="sm">Section</FormLabel>
            <Input value={form.section} onChange={set('section')} />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="sm">Subject</FormLabel>
            <Input value={form.subject} onChange={set('subject')} />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="sm">Subject code</FormLabel>
            <Input value={form.subjectCode} onChange={set('subjectCode')} />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="sm">Room</FormLabel>
            <Input value={form.room} onChange={set('room')} />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="sm">Academic year</FormLabel>
            <Input value={form.academicYear} onChange={set('academicYear')} placeholder="2025-26" />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="sm">Semester</FormLabel>
            <Input value={form.semester} onChange={set('semester')} placeholder="6" />
          </FormControl>
        </SimpleGrid>
        <FormControl mb={4}>
          <FormLabel fontSize="sm">Description</FormLabel>
          <Textarea rows={3} value={form.description} onChange={set('description')} />
        </FormControl>
        <FormControl mb={4}>
          <FormLabel fontSize="sm">Meeting link</FormLabel>
          <Input value={form.meetLink} onChange={set('meetLink')} placeholder="https://meet.google.com/…" />
        </FormControl>
        <FormControl mb={4}>
          <FormLabel fontSize="sm">Theme colour</FormLabel>
          <ColorPicker
            value={form.coverColor}
            options={CLASS_COLORS}
            onChange={(color) => setForm((prev) => ({ ...prev, coverColor: color }))}
          />
        </FormControl>
        <Box maxW="360px">
          <Text fontSize="xs" color="gray.500" mb={2}>
            Preview
          </Text>
          <ClassCardPreview
            color={form.coverColor}
            title={form.name || 'Class name'}
            subtitle={[form.section, form.subject].filter(Boolean).join(' · ')}
          />
        </Box>
      </SectionCard>

      <SectionCard title="Class code" subtitle="Students use this to join." mb={4}>
        <Flex align="center" gap={4} wrap="wrap">
          <Text fontSize="2xl" fontWeight="700" fontFamily="mono" letterSpacing="wider">
            {code}
          </Text>
          <Button size="sm" variant="outline" onClick={onCopy}>
            {hasCopied ? 'Copied!' : 'Copy'}
          </Button>
          <Button size="sm" variant="outline" onClick={regenerate}>
            Generate new code
          </Button>
        </Flex>
        <Checkbox
          mt={4}
          size="sm"
          isChecked={settings.allowJoinByCode}
          onChange={(event) => setSetting('allowJoinByCode', event.target.checked)}
        >
          Allow joining with this code
        </Checkbox>
        <Checkbox
          mt={2}
          size="sm"
          isChecked={settings.requireApproval}
          onChange={(event) => setSetting('requireApproval', event.target.checked)}
        >
          Review every join request before admitting a student
        </Checkbox>
      </SectionCard>

      <SectionCard title="Permissions & notifications" mb={4}>
        <FormControl mb={4} maxW="360px">
          <FormLabel fontSize="sm">Who can post and comment</FormLabel>
          <Select value={settings.whoCanPost} onChange={(event) => setSetting('whoCanPost', event.target.value)}>
            <option value="students_can_post">Students can post and comment</option>
            <option value="students_can_comment">Students can only comment</option>
            <option value="teachers_only">Only teachers can post or comment</option>
          </Select>
        </FormControl>
        <Checkbox
          size="sm"
          isChecked={settings.showGradesToStudents}
          onChange={(event) => setSetting('showGradesToStudents', event.target.checked)}
        >
          Let students see their gradebook
        </Checkbox>
        <Checkbox
          mt={2}
          size="sm"
          isChecked={settings.emailNotifications}
          onChange={(event) => setSetting('emailNotifications', event.target.checked)}
        >
          Email the class when something is posted
        </Checkbox>
        <FormControl mt={4} maxW="200px">
          <FormLabel fontSize="sm">Default points for new work</FormLabel>
          <Input
            type="number"
            min={0}
            value={settings.defaultPoints}
            onChange={(event) => setSetting('defaultPoints', Number(event.target.value) || 0)}
          />
          <FormHelperText fontSize="xs">Pre-filled when you create an assignment.</FormHelperText>
        </FormControl>
      </SectionCard>

      <Flex gap={2} mb={8}>
        <Button colorScheme="blue" onClick={save} isLoading={saving}>
          Save changes
        </Button>
      </Flex>

      <SectionCard title="Danger zone" borderColor="red.200">
        <Flex justify="space-between" align="center" gap={3} wrap="wrap" py={2}>
          <Box>
            <Text fontSize="sm" fontWeight="600">
              {klass.status === 'archived' ? 'Restore this class' : 'Archive this class'}
            </Text>
            <Text fontSize="xs" color="gray.500">
              Archived classes stay readable but drop out of the main list and accept no new work.
            </Text>
          </Box>
          <Button size="sm" variant="outline" onClick={archive}>
            {klass.status === 'archived' ? 'Restore' : 'Archive'}
          </Button>
        </Flex>
        {klass.isOwner && (
          <>
            <Divider my={3} />
            <Flex justify="space-between" align="center" gap={3} wrap="wrap" py={2}>
              <Box>
                <Text fontSize="sm" fontWeight="600" color="red.600">
                  Delete this class
                </Text>
                <Text fontSize="xs" color="gray.500">
                  Removes every post, assignment, submission, grade, quiz and generated lecture artefact.
                </Text>
              </Box>
              <Button size="sm" colorScheme="red" onClick={destroy}>
                Delete permanently
              </Button>
            </Flex>
          </>
        )}
      </SectionCard>
    </Box>
  );
}
