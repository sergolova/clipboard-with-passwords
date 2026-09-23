# ---- release packaging ---------------------------------------------------
# Local (symlinked) copy needs the COMPILED schema too, because
# `gsettings --schemadir schemas` must see the keys for live debugging.
# The EGO bundle must NOT contain it — GNOME 45+ compiles the schema from the
# .xml at install time (shexli rule EGO-P-006). Likewise, only compiled .mo
# travels; .po/.pot stay out of the package.
JS_LIBS     = *.js
LOCALES     = locale/*/LC_MESSAGES/*.mo
META        = metadata.json stylesheet.css LICENSE.rst README.md
SCHEMA_XML  = schemas/org.gnome.shell.extensions.clipboard-indicator.gschema.xml

MODULES        = $(JS_LIBS) $(LOCALES) $(META) schemas/
BUNDLE_MODULES = $(JS_LIBS) $(LOCALES) $(META) $(SCHEMA_XML)
INSTALLPATH=~/.local/share/gnome-shell/extensions/clipboard-with-passwords@sergolova/

all: compile-locales compile-settings

compile-settings:
	glib-compile-schemas --strict --targetdir=schemas/ schemas

compile-locales:
	$(foreach file, $(wildcard locale/*/LC_MESSAGES/*.po), \
		msgfmt $(file) -o $(subst .po,.mo,$(file));)

update-po-files:
	xgettext -L Python --from-code=UTF-8 -k_ -kN_ -o clipboard-with-passwords.pot *.js
	$(foreach file, $(wildcard locale/*/LC_MESSAGES/*.po), \
		msgmerge $(file) clipboard-with-passwords.pot -o $(file);)

install: all
	rm -rf $(INSTALLPATH)
	mkdir -p $(INSTALLPATH)
	cp -r --parents $(MODULES) $(INSTALLPATH)

nested-session:
	dbus-run-session -- env MUTTER_DEBUG_NUM_DUMMY_MONITORS=1 \
		MUTTER_DEBUG_DUMMY_MODE_SPECS=2048x1536 \
		MUTTER_DEBUG_DUMMY_MONITOR_SCALES=2 gnome-shell --nested --wayland

# The bundle for EGO must use the CLEAN set (BUNDLE_MODULES): only the
# gschema.xml (GNOME 45+ compiles it at install), only compiled .mo —
# never gschemas.compiled, never .po/.pot (shexli rules EGO-P-006, EGO-P-007).
bundle: all
	zip -FSr bundle.zip $(BUNDLE_MODULES)
