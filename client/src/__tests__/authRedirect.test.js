import { describe, it, expect } from 'vitest';
import { loginPathFor, redirectTargetFrom } from '../authRedirect';

describe('loginPathFor', () => {
  it('remembers the interrupted page, query and hash included', () => {
    const path = loginPathFor({
      pathname: '/learning/c/abc123/grades',
      search: '?tab=late',
      hash: '#row-7',
    });
    expect(path).toBe('/login?redirect=%2Flearning%2Fc%2Fabc123%2Fgrades%3Ftab%3Dlate%23row-7');
  });

  it('adds nothing for pages there is no point returning to', () => {
    expect(loginPathFor({ pathname: '/login', search: '', hash: '' })).toBe('/login');
    expect(loginPathFor({ pathname: '/', search: '', hash: '' })).toBe('/login');
    expect(loginPathFor({ pathname: '/userroles', search: '', hash: '' })).toBe('/login');
    expect(loginPathFor(null)).toBe('/login');
  });

  // A page can trip two gates: the navbar redirects the moment its session
  // check fails, then a request the page had already sent 401s and redirects
  // again — by which point we are on /login and must keep what is there.
  it('keeps a destination already recorded on the login URL', () => {
    expect(
      loginPathFor({ pathname: '/login', search: '?redirect=%2Flearning%2Fshort%2Fjoin', hash: '' }),
    ).toBe('/login?redirect=%2Flearning%2Fshort%2Fjoin');
  });
});

describe('redirectTargetFrom', () => {
  it('round-trips a path stashed by loginPathFor', () => {
    const search = loginPathFor({ pathname: '/tt/dashboard', search: '?dept=CSE', hash: '' })
      .replace('/login', '');
    expect(redirectTargetFrom(search)).toBe('/tt/dashboard?dept=CSE');
  });

  it('falls back to the roles picker when nothing was remembered', () => {
    expect(redirectTargetFrom('')).toBe('/userroles');
    expect(redirectTargetFrom('?other=1')).toBe('/userroles');
  });

  it('refuses off-site targets so login cannot be used as an open redirect', () => {
    expect(redirectTargetFrom('?redirect=https%3A%2F%2Fevil.com')).toBe('/userroles');
    expect(redirectTargetFrom('?redirect=%2F%2Fevil.com')).toBe('/userroles');
    expect(redirectTargetFrom('?redirect=%2F%5Cevil.com')).toBe('/userroles');
    expect(redirectTargetFrom('?redirect=javascript%3Aalert(1)')).toBe('/userroles');
  });
});
