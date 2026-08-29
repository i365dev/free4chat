//go:build darwin

package credentials

import (
	"fmt"

	"github.com/keybase/go-keychain"
)

type keychainStore struct{}

func newSystemStore() Store { return keychainStore{} }

func keychainAccount(provider, key string) string { return provider + "/" + key }

// keychainLocator deliberately leaves label blank. macOS does not guarantee
// that a generic-password item's display label survives a save, and using it
// as a lookup predicate made a successfully provisioned credential invisible
// on the next Runtime read. Service plus account is this application's stable
// private identity for the item.
func keychainLocator(provider, key string) (service, account, label, accessGroup string) {
	return serviceName, keychainAccount(provider, key), "", ""
}

func (keychainStore) Get(provider, key string) (string, error) {
	service, account, label, accessGroup := keychainLocator(provider, key)
	data, err := keychain.GetGenericPassword(service, account, label, accessGroup)
	if err != nil {
		return "", fmt.Errorf("native credential lookup failed")
	}
	if len(data) == 0 {
		return "", ErrNotFound
	}
	return string(data), nil
}

func (keychainStore) Set(provider, key, value string) error {
	service, account, label, accessGroup := keychainLocator(provider, key)
	query := keychain.NewGenericPassword(service, account, label, nil, accessGroup)
	if existing, err := keychain.GetGenericPassword(service, account, label, accessGroup); err != nil {
		return fmt.Errorf("native credential lookup failed")
	} else if len(existing) > 0 {
		update := keychain.NewItem()
		update.SetData([]byte(value))
		if err := keychain.UpdateItem(query, update); err != nil {
			return fmt.Errorf("native credential update failed")
		}
		return nil
	}
	item := keychain.NewGenericPassword(service, account, label, []byte(value), accessGroup)
	if err := keychain.AddItem(item); err != nil {
		return fmt.Errorf("native credential save failed")
	}
	return nil
}

func (keychainStore) Delete(provider, key string) error {
	service, account, label, accessGroup := keychainLocator(provider, key)
	value, err := keychain.GetGenericPassword(service, account, label, accessGroup)
	if err != nil {
		return fmt.Errorf("native credential lookup failed")
	}
	if len(value) == 0 {
		return nil
	}
	item := keychain.NewGenericPassword(service, account, label, nil, accessGroup)
	if err := keychain.DeleteItem(item); err != nil {
		return fmt.Errorf("native credential delete failed")
	}
	return nil
}
