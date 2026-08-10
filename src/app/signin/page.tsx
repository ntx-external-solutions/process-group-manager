import { redirect } from 'next/navigation';

/**
 * Sign-in lives on the front page now. This exists so bookmarks and the links that
 * were handed round during testing keep working.
 */
export default function SignInPage() {
  redirect('/');
}
