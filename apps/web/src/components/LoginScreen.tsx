import { useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useAuth } from '../state/AuthContext.js';
import { ApiError } from '../lib/api.js';

export function LoginScreen(): ReactNode {
  const { login, register } = useAuth();
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsBusy(true);
    try {
      if (tab === 'login') await login({ identifier, password });
      else await register({ email, username, firstName, lastName, password });
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.',
      );
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="ta-centered">
      <Card padding={6} width={420} elevation="med">
        <form onSubmit={submit}>
          <VStack gap={4}>
            <VStack gap={1}>
              <Heading level={2}>TeamAgents</Heading>
              <Text type="supporting" color="secondary">
                Team chat with AI coding agents built in.
              </Text>
            </VStack>

            {/* Real tabs rather than two buttons: the submit button below is
                then the only control named "Sign in". */}
            <TabList
              value={tab}
              onChange={(value) => {
                setTab(value as 'login' | 'register');
                setError(null);
              }}
              hasDivider
            >
              <Tab value="login" label="Sign in" />
              <Tab value="register" label="Create account" />
            </TabList>

            {tab === 'login' ? (
              <VStack gap={3}>
                <TextInput
                  label="Email or username"
                  value={identifier}
                  onChange={setIdentifier}
                  placeholder="ada@teamagents.dev"
                  hasAutoFocus
                  isRequired
                />
                <TextInput
                  label="Password"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  isRequired
                />
              </VStack>
            ) : (
              <VStack gap={3}>
                <HStack gap={3}>
                  <TextInput
                    label="First name"
                    value={firstName}
                    onChange={setFirstName}
                    hasAutoFocus
                    isRequired
                  />
                  <TextInput label="Last name" value={lastName} onChange={setLastName} isRequired />
                </HStack>
                <TextInput
                  label="Email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  isRequired
                />
                <TextInput
                  label="Username"
                  value={username}
                  onChange={setUsername}
                  description="Letters, numbers, dots, dashes or underscores"
                  isRequired
                />
                <TextInput
                  label="Password"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  description="At least 8 characters"
                  isRequired
                />
              </VStack>
            )}

            {error ? (
              <Text type="supporting" color="primary" role="alert">
                {error}
              </Text>
            ) : null}

            <Button
              label={tab === 'login' ? 'Sign in' : 'Create account'}
              variant="primary"
              type="submit"
              isLoading={isBusy}
              width="100%"
            />
          </VStack>
        </form>
      </Card>
    </div>
  );
}
