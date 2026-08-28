//go:build darwin

package credentials

import (
	"fmt"

	"github.com/keybase/go-keychain"
)

type keychainStore struct{}

func newSystemStore() Store { return keychainStore{} }

func keychainAccount(provider, key string) string { return provider + "/" + key }

func (keychainStore) Get(provider, key string) (string, error) {
	data, err := keychain.GetGenericPassword(serviceName, keychainAccount(provider, key), serviceName, "")
	if err != nil {
		return "", fmt.Errorf("native credential lookup failed")
	}
	if len(data) == 0 {
		return "", ErrNotFound
	}
	return string(data), nil
}

func (keychainStore) Set(provider, key, value string) error {
	account := keychainAccount(provider, key)
	query := keychain.NewGenericPassword(serviceName, account, serviceName, nil, "")
	if existing, err := keychain.GetGenericPassword(serviceName, account, serviceName, ""); err != nil {
		return fmt.Errorf("native credential lookup failed")
	} else if len(existing) > 0 {
		update := keychain.NewItem()
		update.SetData([]byte(value))
		if err := keychain.UpdateItem(query, update); err != nil {
			return fmt.Errorf("native credential update failed")
		}
		return nil
	}
	item := keychain.NewGenericPassword(serviceName, account, serviceName, []byte(value), "")
	if err := keychain.AddItem(item); err != nil {
		return fmt.Errorf("native credential save failed")
	}
	return nil
}

func (keychainStore) Delete(provider, key string) error {
	account := keychainAccount(provider, key)
	value, err := keychain.GetGenericPassword(serviceName, account, serviceName, "")
	if err != nil {
		return fmt.Errorf("native credential lookup failed")
	}
	if len(value) == 0 {
		return nil
	}
	item := keychain.NewGenericPassword(serviceName, account, serviceName, nil, "")
	if err := keychain.DeleteItem(item); err != nil {
		return fmt.Errorf("native credential delete failed")
	}
	return nil
}
