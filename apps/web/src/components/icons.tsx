import type { ReactElement, SVGProps } from 'react';
import {
  CodeXml,
  LogOut,
  Moon,
  Paperclip,
  SquareCode,
  Sun,
  Trash2,
  UserPlus,
  Users,
  Wrench,
} from 'lucide-react';

/**
 * Icons used in places where Astryx's semantic set does not reach.
 *
 * Astryx ships 28 semantic names covering UI chrome only, so anything
 * product-specific comes from Lucide (a dependency of the theme, declared
 * explicitly in our package.json) or is drawn here in the same 24×24,
 * 2px-stroke style so it sits correctly beside the rest.
 */

/** Two people with a plus: start a group chat. Lucide has no `users-plus`. */
export function UsersPlusIcon(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/* Front person, borrowed from Lucide's `users` so the weight matches. */}
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      {/* The person behind. */}
      <path d="M16 3.128a4 4 0 0 1 0 7.744" />
      {/* Plus, in the corner the second person's shoulders would have used. */}
      <path d="M19 16v6" />
      <path d="M22 19h-6" />
    </svg>
  );
}

export {
  // `</>` for repositories and credentials; distinct from the filled
  // `SquareCode` used by the composer's insert-code-block action, so the two
  // are not mistaken for each other.
  CodeXml as RepositoriesIcon,
  LogOut as SignOutIcon,
  Moon as MoonIcon,
  Paperclip as PaperclipIcon,
  SquareCode as CodeBlockIcon,
  Sun as SunIcon,
  Trash2 as TrashIcon,
  UserPlus as UserPlusIcon,
  Users as EveryoneIcon,
  Wrench as AgentIcon,
};
