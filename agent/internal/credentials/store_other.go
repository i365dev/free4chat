//go:build !darwin

package credentials

type unavailableStore struct{}

func newSystemStore() Store { return unavailableStore{} }

func (unavailableStore) Get(string, string) (string, error) { return "", ErrUnavailable }
func (unavailableStore) Set(string, string, string) error   { return ErrUnavailable }
func (unavailableStore) Delete(string, string) error        { return ErrUnavailable }
