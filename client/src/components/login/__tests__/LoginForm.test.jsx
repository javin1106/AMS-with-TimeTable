/**
 * The login form's captcha behaviour.
 *
 * The assertions worth having are about *when* the challenge appears and how it
 * is rendered. It must not appear for an ordinary sign-in — that would be the
 * whole institute's experience of this feature — and it must be drawn through an
 * `<img>` rather than injected into the page, because an inline SVG can carry a
 * `<script>` and this is the one page anonymous traffic reaches.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChakraProvider } from '@chakra-ui/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import LoginForm from '../LoginForm';

vi.mock('../../../getenvironment', () => ({ default: () => 'http://api.test' }));

const CHALLENGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg>';

const renderForm = () =>
  render(
    <ChakraProvider>
      <MemoryRouter>
        <LoginForm />
      </MemoryRouter>
    </ChakraProvider>,
  );

/** Queues fetch replies in order, so a test reads as the exchange it describes. */
const queueFetch = (...replies) => {
  const fetchMock = vi.fn();
  replies.forEach(({ ok = true, body = {} }) => {
    fetchMock.mockResolvedValueOnce({ ok, json: () => Promise.resolve(body) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const signIn = async (user) => {
  await user.type(screen.getByPlaceholderText('Enter your email'), 'asha@nitj.ac.in');
  await user.type(screen.getByPlaceholderText('Enter your password'), 'hunter2');
  await user.click(screen.getByRole('button', { name: 'Login' }));
};

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('LoginForm captcha', () => {
  it('shows no captcha on a plain failed sign-in', async () => {
    // A typo is the common case and must not cost the user an image to read.
    queueFetch({ ok: false, body: { message: 'Invalid email or password.', captchaRequired: false } });
    const user = userEvent.setup();
    renderForm();

    await signIn(user);

    await screen.findByText(/Invalid email or password/);
    expect(screen.queryByAltText('Characters to type')).not.toBeInTheDocument();
  });

  it('fetches and shows a challenge once the server asks for one', async () => {
    const fetchMock = queueFetch(
      { ok: false, body: { message: 'Invalid email or password.', captchaRequired: true } },
      { ok: true, body: { token: 'tok-1', svg: CHALLENGE_SVG } },
    );
    const user = userEvent.setup();
    renderForm();

    await signIn(user);

    const image = await screen.findByAltText('Characters to type');
    expect(image).toBeInTheDocument();
    expect(fetchMock.mock.calls[1][0]).toBe('http://api.test/auth/captcha');
  });

  it('renders the challenge as an image, never as inline markup', async () => {
    // The security property: an SVG loaded via <img> cannot execute script.
    queueFetch(
      { ok: false, body: { message: 'Invalid email or password.', captchaRequired: true } },
      { ok: true, body: { token: 'tok-1', svg: CHALLENGE_SVG } },
    );
    const user = userEvent.setup();
    const { container } = renderForm();

    await signIn(user);

    const image = await screen.findByAltText('Characters to type');
    expect(image.tagName).toBe('IMG');
    expect(image.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    // The markup itself is nowhere in the document.
    expect(container.querySelector('svg text')).toBeNull();
  });

  it('sends the token and the answer on the next attempt', async () => {
    const fetchMock = queueFetch(
      { ok: false, body: { message: 'Invalid email or password.', captchaRequired: true } },
      { ok: true, body: { token: 'tok-1', svg: CHALLENGE_SVG } },
      { ok: false, body: { message: 'Invalid email or password.', captchaRequired: true } },
    );
    const user = userEvent.setup();
    renderForm();

    await signIn(user);
    await screen.findByAltText('Characters to type');

    await user.type(screen.getByPlaceholderText('Characters from the image'), 'ac4kp');
    await user.click(screen.getByRole('button', { name: 'Login' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const sent = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(sent.captchaToken).toBe('tok-1');
    expect(sent.captchaAnswer).toBe('ac4kp');
  });

  it('keeps the same image after a wrong answer', async () => {
    // A fresh image for every typo would make a mistyped captcha look like a
    // broken one.
    const fetchMock = queueFetch(
      { ok: false, body: { message: 'Invalid email or password.', captchaRequired: true } },
      { ok: true, body: { token: 'tok-1', svg: CHALLENGE_SVG } },
      {
        ok: false,
        body: {
          message: 'The characters did not match. Please try again.',
          captchaRequired: true,
          captchaStale: false,
        },
      },
    );
    const user = userEvent.setup();
    renderForm();

    await signIn(user);
    await screen.findByAltText('Characters to type');
    await user.type(screen.getByPlaceholderText('Characters from the image'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Login' }));

    // Three calls, not four: no new challenge was requested.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByPlaceholderText('Characters from the image')).toHaveValue('');
  });

  it('fetches a new image when the old one has expired', async () => {
    const fetchMock = queueFetch(
      { ok: false, body: { message: 'Invalid email or password.', captchaRequired: true } },
      { ok: true, body: { token: 'tok-1', svg: CHALLENGE_SVG } },
      {
        ok: false,
        body: {
          message: 'That challenge has expired. Please try the new one.',
          captchaRequired: true,
          captchaStale: true,
        },
      },
      { ok: true, body: { token: 'tok-2', svg: CHALLENGE_SVG } },
      { ok: false, body: { message: 'Invalid email or password.', captchaRequired: true } },
    );
    const user = userEvent.setup();
    renderForm();

    await signIn(user);
    await screen.findByAltText('Characters to type');
    await user.type(screen.getByPlaceholderText('Characters from the image'), 'abcde');
    await user.click(screen.getByRole('button', { name: 'Login' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[3][0]).toBe('http://api.test/auth/captcha');

    // And the replacement token is what goes out next.
    await user.type(screen.getByPlaceholderText('Characters from the image'), 'fghjk');
    await user.click(screen.getByRole('button', { name: 'Login' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(JSON.parse(fetchMock.mock.calls[4][1].body).captchaToken).toBe('tok-2');
  });

  it('can be refreshed by hand', async () => {
    const fetchMock = queueFetch(
      { ok: false, body: { message: 'Invalid email or password.', captchaRequired: true } },
      { ok: true, body: { token: 'tok-1', svg: CHALLENGE_SVG } },
      { ok: true, body: { token: 'tok-2', svg: CHALLENGE_SVG } },
    );
    const user = userEvent.setup();
    renderForm();

    await signIn(user);
    await screen.findByAltText('Characters to type');
    await user.click(screen.getByRole('button', { name: 'New image' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2][0]).toBe('http://api.test/auth/captcha');
  });

  it('says so when the challenge image cannot be loaded', async () => {
    // A transient failure here must not read as "your password was wrong".
    queueFetch(
      { ok: false, body: { message: 'Invalid email or password.', captchaRequired: true } },
      { ok: false, body: {} },
    );
    const user = userEvent.setup();
    renderForm();

    await signIn(user);

    await screen.findByText(/Could not load the challenge image/);
  });
});
