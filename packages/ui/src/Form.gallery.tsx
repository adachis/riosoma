import { Input, TextField } from 'react-aria-components';
import { faFloppyDisk } from '@fortawesome/free-solid-svg-icons';
import { Button } from './Button';
import { Disclosure, DisclosurePanel, DisclosureTrigger } from './Disclosure';
import { Description, FieldError, Label } from './Field';
import { Form, FormActions } from './Form';
import { Text } from './Text';
import type { GalleryEntry } from './gallery';

// Gallery examples are a developer tool, so their sample labels are plain text.
export const gallery: GalleryEntry = {
  id: 'ui.form',
  title: 'Form',
  examples: [
    {
      id: 'create',
      render: () => (
        <Form aria-label="Create a database">
          <TextField name="name">
            <Label>Name</Label>
            <Input />
            <Description>Lowercase letters, digits, and dashes.</Description>
            <FieldError />
          </TextField>
          <TextField name="region">
            <Label>Region</Label>
            <Input />
            <Description>Where the primary lives.</Description>
            <FieldError />
          </TextField>
          <FormActions>
            <Button>Cancel</Button>
            <Button type="submit" variant="primary" icon={faFloppyDisk}>
              Create
            </Button>
          </FormActions>
        </Form>
      ),
    },
    {
      id: 'with-errors',
      render: () => (
        <Form
          aria-label="Create a database, with errors"
          validationErrors={{
            name: 'That name is already taken.',
            region: 'Pick a region this cluster can reach.',
          }}
        >
          <TextField name="name" defaultValue="orders">
            <Label>Name</Label>
            <Input />
            <FieldError />
          </TextField>
          <TextField name="region" defaultValue="eu-west-1">
            <Label>Region</Label>
            <Input />
            <FieldError />
          </TextField>
          <FormActions>
            <Button>Cancel</Button>
            <Button type="submit" variant="primary">
              Create
            </Button>
          </FormActions>
        </Form>
      ),
    },
    {
      id: 'with-advanced-settings',
      render: () => (
        <Form aria-label="Replica settings">
          <TextField name="replica">
            <Label>Replica name</Label>
            <Input />
            <FieldError />
          </TextField>
          <Disclosure>
            <DisclosureTrigger>Advanced</DisclosureTrigger>
            <DisclosurePanel>
              <TextField name="lag">
                <Label>Maximum lag</Label>
                <Input />
                <Text slot="description" variant="small">
                  Seconds behind the primary before this replica stops serving reads.
                </Text>
                <FieldError />
              </TextField>
            </DisclosurePanel>
          </Disclosure>
          <FormActions>
            <Button variant="quiet">Reset</Button>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </FormActions>
        </Form>
      ),
    },
    {
      id: 'states',
      render: () => (
        <Form aria-label="Rename a database">
          <TextField name="name">
            <Label>Name</Label>
            <Input />
            <FieldError />
          </TextField>
          <FormActions>
            <Button isDisabled>Cancel</Button>
            <Button type="submit" variant="primary" isPending icon={faFloppyDisk}>
              Saving
            </Button>
          </FormActions>
        </Form>
      ),
    },
  ],
};
