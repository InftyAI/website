.PHONY: build
build:
	hugo --gc


.PHONY: launch
launch: build
	hugo server